// Objective-C++ Node addon that posts macOS notifications directly through
// UNUserNotificationCenter.
//
// Electron's own notification path exposes no way to attach an
// INSendMessageIntent, so the assistant avatar can never become the
// notification icon through it. This addon owns the notification center
// instead: it registers the category, donates a Communication Notification
// intent when a sender avatar is supplied, and routes click / action /
// dismiss responses back to JavaScript.
//
// Delegate ownership is the load-bearing rule here. Electron's
// NotificationPresenterMac claims
// `UNUserNotificationCenter.currentNotificationCenter.delegate` the moment it
// is constructed (by `new Notification()`, by `Notification.isSupported()`, or
// by the renderer's Web Notification API), and it drops responses for
// identifiers it does not own. This addon installs its own delegate, holds a
// strong reference to whichever delegate it displaced, and forwards every
// response it does not own to that delegate. `Show` and `RequestAuthorization`
// re-assert the delegate on the way in, and `EnsureDelegate` exposes the same
// re-assertion to JavaScript: the app builds Electron's presenter once at
// startup, with nothing on screen, and calls it, so the addon's proxy sits in
// front of the presenter for the life of the process.

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <Intents/Intents.h>
#import <UserNotifications/UserNotifications.h>
#import <os/log.h>

#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include <napi.h>

namespace {

// Notifications whose callbacks are still live. A notification that is never
// clicked or dismissed keeps its entry until it is evicted, so the map is
// bounded and the oldest entry is released first.
constexpr size_t kMaxTrackedNotifications = 64;

std::mutex g_mutex;
std::unordered_map<std::string, Napi::ThreadSafeFunction> g_callbacks;
std::deque<std::string> g_callbackOrder;

struct Event {
  std::string kind;
  // Negative when the event carries no action index.
  int actionIndex = -1;
  std::string error;
  // Non-empty on `shown` when the notification went out in a reduced form,
  // naming why: no Communication Notification treatment, or an unregistered
  // category and so no action buttons.
  std::string degraded;
};

// Called with g_mutex held.
void ForgetCallbackLocked(const std::string &id) {
  for (auto it = g_callbackOrder.begin(); it != g_callbackOrder.end(); ++it) {
    if (*it == id) {
      g_callbackOrder.erase(it);
      break;
    }
  }
}

void RememberCallback(const std::string &id, Napi::ThreadSafeFunction tsfn) {
  Napi::ThreadSafeFunction evicted;
  bool hasEvicted = false;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    auto existing = g_callbacks.find(id);
    if (existing != g_callbacks.end()) {
      evicted = existing->second;
      hasEvicted = true;
      ForgetCallbackLocked(id);
      g_callbacks.erase(existing);
    }
    g_callbacks.emplace(id, tsfn);
    g_callbackOrder.push_back(id);
    if (!hasEvicted && g_callbackOrder.size() > kMaxTrackedNotifications) {
      const std::string oldest = g_callbackOrder.front();
      g_callbackOrder.pop_front();
      auto it = g_callbacks.find(oldest);
      if (it != g_callbacks.end()) {
        evicted = it->second;
        hasEvicted = true;
        g_callbacks.erase(it);
      }
    }
  }
  if (hasEvicted) {
    evicted.Release();
  }
}

bool OwnsNotification(const std::string &id) {
  std::lock_guard<std::mutex> lock(g_mutex);
  return g_callbacks.find(id) != g_callbacks.end();
}

// `final` releases the callback: the notification can produce no further
// events. `shown` is not final because a click or a dismissal still follows.
//
// The lock is held across the call. Handing the thread-safe function out from
// under it would let an eviction on another thread release the same function
// mid-call. The queue is unbounded, so `BlockingCall` hands the payload off
// without waiting and the JavaScript callback runs later on its own thread,
// which is what makes holding the lock here safe.
void EmitEvent(const std::string &id, Event event, bool final) {
  std::lock_guard<std::mutex> lock(g_mutex);
  auto it = g_callbacks.find(id);
  if (it == g_callbacks.end()) {
    return;
  }
  Napi::ThreadSafeFunction tsfn = it->second;

  auto *payload = new Event(std::move(event));
  const napi_status status = tsfn.BlockingCall(
      payload, [](Napi::Env env, Napi::Function jsCallback, Event *value) {
        Napi::Object object = Napi::Object::New(env);
        object.Set("kind", Napi::String::New(env, value->kind));
        if (value->actionIndex >= 0) {
          object.Set("actionIndex", Napi::Number::New(env, value->actionIndex));
        }
        if (!value->error.empty()) {
          object.Set("error", Napi::String::New(env, value->error));
        }
        if (!value->degraded.empty()) {
          object.Set("degraded", Napi::String::New(env, value->degraded));
        }
        jsCallback.Call({object});
        delete value;
      });
  if (status != napi_ok) {
    delete payload;
  }
  if (final) {
    g_callbacks.erase(it);
    ForgetCallbackLocked(id);
    tsfn.Release();
  }
}

std::string ToStdString(NSString *value) {
  if (value == nil) {
    return std::string();
  }
  return std::string(value.UTF8String ?: "");
}

NSString *ToNSString(const std::string &value) {
  return [NSString stringWithUTF8String:value.c_str()] ?: @"";
}

}  // namespace

// ---------------------------------------------------------------------------
// Delegate
// ---------------------------------------------------------------------------

@interface VellumNotifierDelegate : NSObject <UNUserNotificationCenterDelegate>
// Strong: every response this addon does not own is forwarded here, and the
// notification center itself holds its delegate weakly, so a weak reference
// would leave responses going nowhere the moment the displaced delegate lost
// its last other owner. `restoreDelegate` hands the seat back and drops it.
@property(nonatomic, strong)
    id<UNUserNotificationCenterDelegate> previousDelegate;
@end

@implementation VellumNotifierDelegate

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:
             (void (^)(UNNotificationPresentationOptions))completionHandler {
  const std::string identifier = ToStdString(notification.request.identifier);
  if (!OwnsNotification(identifier)) {
    id<UNUserNotificationCenterDelegate> previous = self.previousDelegate;
    if (previous != nil && [previous respondsToSelector:_cmd]) {
      [previous userNotificationCenter:center
              willPresentNotification:notification
                withCompletionHandler:completionHandler];
      return;
    }
  }
  completionHandler(UNNotificationPresentationOptionBanner |
                    UNNotificationPresentationOptionSound |
                    UNNotificationPresentationOptionList);
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
    didReceiveNotificationResponse:(UNNotificationResponse *)response
             withCompletionHandler:(void (^)(void))completionHandler {
  const std::string identifier =
      ToStdString(response.notification.request.identifier);
  if (!OwnsNotification(identifier)) {
    id<UNUserNotificationCenterDelegate> previous = self.previousDelegate;
    if (previous != nil && [previous respondsToSelector:_cmd]) {
      [previous userNotificationCenter:center
          didReceiveNotificationResponse:response
                   withCompletionHandler:completionHandler];
      return;
    }
    completionHandler();
    return;
  }

  NSString *action = response.actionIdentifier;
  Event event;
  if ([action isEqualToString:UNNotificationDefaultActionIdentifier]) {
    event.kind = "click";
  } else if ([action isEqualToString:UNNotificationDismissActionIdentifier]) {
    event.kind = "dismiss";
  } else {
    // Action identifiers are minted as `<categoryId>.action.<index>`, so the
    // trailing component is the index the JS side registered the button at.
    NSRange separator = [action rangeOfString:@".action."
                                      options:NSBackwardsSearch];
    if (separator.location == NSNotFound) {
      completionHandler();
      return;
    }
    NSString *suffix =
        [action substringFromIndex:separator.location + separator.length];
    NSScanner *scanner = [NSScanner scannerWithString:suffix];
    int index = 0;
    if (![scanner scanInt:&index] || !scanner.isAtEnd || index < 0) {
      completionHandler();
      return;
    }
    event.kind = "action";
    event.actionIndex = index;
  }

  EmitEvent(identifier, std::move(event), true);
  completionHandler();
}

@end

namespace {

VellumNotifierDelegate *g_delegate = nil;
NSMutableDictionary<NSString *, UNNotificationCategory *> *g_categories = nil;

bool IsBundled() { return NSBundle.mainBundle.bundleIdentifier != nil; }

void EnsureDelegateInstalled() {
  UNUserNotificationCenter *center =
      [UNUserNotificationCenter currentNotificationCenter];
  if (g_delegate == nil) {
    g_delegate = [[VellumNotifierDelegate alloc] init];
  }
  id<UNUserNotificationCenterDelegate> current = center.delegate;
  if (current == g_delegate) {
    return;
  }
  if (current != nil) {
    g_delegate.previousDelegate = current;
  }
  center.delegate = g_delegate;
}

void RestoreDelegate() {
  if (g_delegate == nil) {
    return;
  }
  UNUserNotificationCenter *center =
      [UNUserNotificationCenter currentNotificationCenter];
  if (center.delegate == g_delegate) {
    center.delegate = g_delegate.previousDelegate;
  }
  g_delegate.previousDelegate = nil;
}

// One application of the union at a time, with a request that arrives while
// one is in flight coalesced into a single re-run. These two flags and
// `g_categories` are touched only on the main thread: that is where the
// JavaScript surface runs and where the completion below hands control back.
bool g_applyingCategories = false;
bool g_categoriesDirty = false;

// `verify` re-reads the written set once and re-applies when the addon's
// categories are missing from it, and is false on that repair pass so a center
// that keeps dropping them cannot spin.
void ApplyCategories(bool verify = true);

// Ends one application, re-running it for a request that arrived mid-flight or,
// failing that, for a write that did not land.
void FinishApplyingCategories(bool repair) {
  g_applyingCategories = false;
  if (g_categoriesDirty) {
    g_categoriesDirty = false;
    ApplyCategories();
  } else if (repair) {
    ApplyCategories(false);
  }
}

// Hands the notification center the union of what it already holds and every
// category this addon has registered. Replacing the set instead would drop
// categories registered by anything else in the process. The union is a
// read-modify-write straddling an asynchronous fetch, and Electron's own
// `CocoaNotification::Show` does the same read-modify-write under no shared
// lock, so an application that interleaves with one of those can be written
// back over. The verification pass below is what catches that.
void ApplyCategories(bool verify) {
  if (g_applyingCategories) {
    g_categoriesDirty = true;
    return;
  }
  g_applyingCategories = true;
  UNUserNotificationCenter *center =
      [UNUserNotificationCenter currentNotificationCenter];
  NSDictionary<NSString *, UNNotificationCategory *> *ours =
      [g_categories copy];
  [center getNotificationCategoriesWithCompletionHandler:^(
              NSSet<UNNotificationCategory *> *existing) {
    NSMutableDictionary<NSString *, UNNotificationCategory *> *merged =
        [NSMutableDictionary dictionary];
    for (UNNotificationCategory *category in existing) {
      merged[category.identifier] = category;
    }
    // Ours win on a shared identifier: the JS side mints one identifier per
    // ordered action set, so a collision means the same buttons either way.
    [merged addEntriesFromDictionary:ours];
    [center setNotificationCategories:[NSSet setWithArray:merged.allValues]];
    if (!verify) {
      dispatch_async(dispatch_get_main_queue(), ^{
        FinishApplyingCategories(false);
      });
      return;
    }
    [center getNotificationCategoriesWithCompletionHandler:^(
                NSSet<UNNotificationCategory *> *written) {
      NSMutableSet<NSString *> *writtenIds = [NSMutableSet set];
      for (UNNotificationCategory *category in written) {
        [writtenIds addObject:category.identifier];
      }
      BOOL dropped = NO;
      for (NSString *identifier in ours) {
        if (![writtenIds containsObject:identifier]) {
          dropped = YES;
          break;
        }
      }
      dispatch_async(dispatch_get_main_queue(), ^{
        FinishApplyingCategories(dropped);
      });
    }];
  }];
}

void RememberCategory(NSString *categoryId, NSArray<NSString *> *actionTitles) {
  if (g_categories == nil) {
    g_categories = [NSMutableDictionary dictionary];
  }
  NSMutableArray<UNNotificationAction *> *actions = [NSMutableArray array];
  [actionTitles enumerateObjectsUsingBlock:^(NSString *title, NSUInteger index,
                                             BOOL *stop) {
    NSString *identifier =
        [NSString stringWithFormat:@"%@.action.%lu", categoryId,
                                   (unsigned long)index];
    [actions addObject:[UNNotificationAction
                           actionWithIdentifier:identifier
                                          title:title
                                        options:
                                            UNNotificationActionOptionForeground]];
  }];
  g_categories[categoryId] = [UNNotificationCategory
      categoryWithIdentifier:categoryId
                     actions:actions
           intentIdentifiers:@[]
                     options:UNNotificationCategoryOptionCustomDismissAction];
}

struct SenderRequest {
  std::string id;
  std::string name;
  std::string avatarPngPath;
  std::string conversationId;
};

struct ShowRequest {
  std::string id;
  std::string title;
  std::string subtitle;
  std::string body;
  std::string categoryId;
  std::vector<std::string> actions;
  bool hasSender = false;
  SenderRequest sender;
};

INPerson *MakePerson(NSString *identifier, NSString *displayName, INImage *image,
                     BOOL isMe) {
  INPersonHandle *handle =
      [[INPersonHandle alloc] initWithValue:identifier
                                       type:INPersonHandleTypeUnknown];
  return [[INPerson alloc] initWithPersonHandle:handle
                                 nameComponents:nil
                                    displayName:displayName
                                          image:image
                              contactIdentifier:nil
                               customIdentifier:identifier
                                           isMe:isMe
                                 suggestionType:INPersonSuggestionTypeNone];
}

struct SenderContent {
  UNNotificationContent *content = nil;
  // Empty when the intent was applied; otherwise why the plain layout is
  // going out instead, which the `shown` event carries back to JavaScript.
  std::string degraded;
};

SenderContent Degraded(UNNotificationContent *content, std::string reason) {
  os_log_error(OS_LOG_DEFAULT, "vellum-notifier: %{public}s", reason.c_str());
  return {content, std::move(reason)};
}

// Returns content updated with a donated Communication Notification intent, or
// the plain content when anything on the intent path fails. The entitlement is
// restricted: an unsigned build, a build without the provisioning profile, or a
// missing avatar all land here and post an ordinary notification.
SenderContent ContentWithSenderIntent(UNMutableNotificationContent *content,
                                      const ShowRequest &request) {
  @try {
    NSString *avatarPath = ToNSString(request.sender.avatarPngPath);
    NSData *avatarData = [NSData dataWithContentsOfFile:avatarPath];
    if (avatarData == nil) {
      return Degraded(content, "the avatar file could not be read");
    }
    INImage *image = [INImage imageWithImageData:avatarData];
    NSString *senderId = ToNSString(request.sender.id);
    NSString *senderName = ToNSString(request.sender.name);
    NSString *conversationId = ToNSString(request.sender.conversationId);
    INPerson *sender = MakePerson(senderId, senderName, image, NO);
    INPerson *me = MakePerson(@"me", nil, nil, YES);

    const bool grouped = !request.subtitle.empty();
    INSpeakableString *groupName =
        grouped ? [[INSpeakableString alloc]
                      initWithSpokenPhrase:ToNSString(request.subtitle)]
                : nil;
    INSendMessageIntent *intent = [[INSendMessageIntent alloc]
             initWithRecipients:grouped ? @[ me, sender ] : @[ me ]
            outgoingMessageType:INOutgoingMessageTypeOutgoingMessageText
                        content:ToNSString(request.body)
             speakableGroupName:groupName
         conversationIdentifier:conversationId
                    serviceName:nil
                         sender:sender
                    attachments:nil];
    if (grouped) {
      // The group image is what macOS draws large, so the assistant's avatar
      // has to hang off the group rather than only off the sender.
      [intent setImage:image forParameterNamed:@"speakableGroupName"];
    }

    INInteraction *interaction = [[INInteraction alloc] initWithIntent:intent
                                                              response:nil];
    interaction.direction = INInteractionDirectionIncoming;
    [interaction donateInteractionWithCompletion:^(NSError *error){
    }];

    NSError *updateError = nil;
    UNNotificationContent *updated =
        [content contentByUpdatingWithProvider:intent error:&updateError];
    if (updated != nil && updateError == nil) {
      return {updated, std::string()};
    }
    return Degraded(content,
                    updateError != nil
                        ? "contentByUpdatingWithProvider: " +
                              ToStdString(updateError.localizedDescription)
                        : "contentByUpdatingWithProvider: returned no content");
  } @catch (NSException *exception) {
    return Degraded(content,
                    "the intent path raised: " + ToStdString(exception.reason));
  }
}

void PostNotification(const ShowRequest &request) {
  NSString *categoryId = ToNSString(request.categoryId);
  // Every action set the app posts is registered through `registerCategories`
  // at startup, because `setNotificationCategories:` applies asynchronously
  // and a category minted in the runloop turn its notification is posted can
  // miss it. An identifier that is not registered by then cannot be repaired
  // here for the same reason, so the notification goes out without one and the
  // `shown` event names the reason. An empty identifier is a notification that
  // asks for no buttons.
  std::string degraded;
  const bool hasCategory =
      categoryId.length > 0 && g_categories[categoryId] != nil;
  if (categoryId.length > 0 && !hasCategory) {
    degraded = "the category " + request.categoryId +
               " is not registered, so the action buttons are missing";
    os_log_error(OS_LOG_DEFAULT, "vellum-notifier: %{public}s",
                 degraded.c_str());
  }

  UNMutableNotificationContent *content =
      [[UNMutableNotificationContent alloc] init];
  content.title = ToNSString(request.title);
  if (!request.subtitle.empty()) {
    content.subtitle = ToNSString(request.subtitle);
  }
  content.body = ToNSString(request.body);
  content.sound = [UNNotificationSound defaultSound];
  if (hasCategory) {
    content.categoryIdentifier = categoryId;
  }

  UNNotificationContent *finalContent = content;
  if (request.hasSender) {
    SenderContent applied = ContentWithSenderIntent(content, request);
    finalContent = applied.content;
    if (!applied.degraded.empty()) {
      degraded = degraded.empty() ? applied.degraded
                                  : degraded + "; " + applied.degraded;
    }
  }

  const std::string id = request.id;
  UNNotificationRequest *notificationRequest =
      [UNNotificationRequest requestWithIdentifier:ToNSString(id)
                                           content:finalContent
                                           trigger:nil];
  [[UNUserNotificationCenter currentNotificationCenter]
      addNotificationRequest:notificationRequest
       withCompletionHandler:^(NSError *error) {
         if (error != nil) {
           Event event;
           event.kind = "failed";
           event.error = ToStdString(error.localizedDescription);
           EmitEvent(id, std::move(event), true);
           return;
         }
         Event event;
         event.kind = "shown";
         event.degraded = degraded;
         EmitEvent(id, std::move(event), false);
       }];
}

// ---------------------------------------------------------------------------
// JavaScript surface
// ---------------------------------------------------------------------------

Napi::Value IsSupported(const Napi::CallbackInfo &info) {
  // UNUserNotificationCenter raises in a process with no bundle identifier, so
  // an unbundled run (a bare `electron main.js`) reports unsupported rather
  // than taking the whole app down on the first post.
  return Napi::Boolean::New(info.Env(), IsBundled());
}

// Puts this addon's delegate back in front of whoever holds the notification
// center's seat. The app calls this once at startup, after deliberately
// building Electron's presenter, and again after every notification Electron
// posts, so a response to a notification this addon posted is never routed to
// a presenter that discards it.
Napi::Value EnsureDelegate(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (IsBundled()) {
    EnsureDelegateInstalled();
  }
  return env.Undefined();
}

// Returns the notification center's delegate to whoever held it before this
// addon installed its own, and drops the addon's reference to them. Called at
// quit.
Napi::Value RestoreDelegateBinding(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  RestoreDelegate();
  return env.Undefined();
}

struct AuthorizationResult {
  bool granted = false;
  std::string error;
};

Napi::Object ToAuthorizationObject(Napi::Env env,
                                   const AuthorizationResult &result) {
  Napi::Object object = Napi::Object::New(env);
  object.Set("granted", Napi::Boolean::New(env, result.granted));
  if (!result.error.empty()) {
    object.Set("error", Napi::String::New(env, result.error));
  }
  return object;
}

// Prompts for notification authorization and reports the answer to the
// optional callback. This is the whole permission probe: going through
// `electron.Notification` instead would build Electron's presenter, which
// takes the delegate and strands responses to notifications already on screen.
Napi::Value RequestAuthorization(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  const bool hasCallback = info.Length() > 0 && info[0].IsFunction();
  if (!IsBundled()) {
    if (hasCallback) {
      AuthorizationResult result;
      result.error = "Notifications require a bundled app";
      info[0].As<Napi::Function>().Call({ToAuthorizationObject(env, result)});
    }
    return env.Undefined();
  }

  EnsureDelegateInstalled();

  // Owned by the completion block: a prompt the user never answers destroys
  // the block without calling it, and the deleter releases the function then
  // rather than leaking it for the life of the process.
  std::shared_ptr<Napi::ThreadSafeFunction> tsfn;
  if (hasCallback) {
    Napi::ThreadSafeFunction created =
        Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(),
                                      "vellum-notifier-authorization", 0, 1);
    // The prompt waits on the user, so it must not hold the process open.
    created.Unref(env);
    tsfn = std::shared_ptr<Napi::ThreadSafeFunction>(
        new Napi::ThreadSafeFunction(created),
        [](Napi::ThreadSafeFunction *function) {
          function->Release();
          delete function;
        });
  }

  [[UNUserNotificationCenter currentNotificationCenter]
      requestAuthorizationWithOptions:UNAuthorizationOptionAlert |
                                      UNAuthorizationOptionSound |
                                      UNAuthorizationOptionBadge
                    completionHandler:^(BOOL granted, NSError *error) {
                      if (!tsfn) {
                        return;
                      }
                      auto *payload = new AuthorizationResult();
                      payload->granted = granted == YES;
                      if (granted != YES && error != nil) {
                        payload->error =
                            ToStdString(error.localizedDescription);
                      }
                      const napi_status status = tsfn->BlockingCall(
                          payload, [](Napi::Env env, Napi::Function jsCallback,
                                      AuthorizationResult *value) {
                            jsCallback.Call(
                                {ToAuthorizationObject(env, *value)});
                            delete value;
                          });
                      if (status != napi_ok) {
                        delete payload;
                      }
                    }];
  return env.Undefined();
}

std::string RequiredString(const Napi::Object &object, const char *key) {
  Napi::Value value = object.Get(key);
  if (!value.IsString()) {
    throw Napi::TypeError::New(object.Env(),
                               std::string("notifier.show: `") + key +
                                   "` must be a string");
  }
  return value.As<Napi::String>().Utf8Value();
}

std::string OptionalString(const Napi::Object &object, const char *key) {
  Napi::Value value = object.Get(key);
  if (!value.IsString()) {
    return std::string();
  }
  return value.As<Napi::String>().Utf8Value();
}

// Registers every category the app can post, so `setNotificationCategories:`
// has applied long before the first notification carries one of them.
Napi::Value RegisterCategories(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsArray()) {
    throw Napi::TypeError::New(
        env, "notifier.registerCategories(categories) requires an array");
  }
  if (!IsBundled()) {
    return env.Undefined();
  }

  Napi::Array categories = info[0].As<Napi::Array>();
  for (uint32_t index = 0; index < categories.Length(); index++) {
    Napi::Value entry = categories.Get(index);
    if (!entry.IsObject()) {
      continue;
    }
    Napi::Object category = entry.As<Napi::Object>();
    NSString *categoryId = ToNSString(RequiredString(category, "categoryId"));
    NSMutableArray<NSString *> *actionTitles = [NSMutableArray array];
    Napi::Value actionsValue = category.Get("actions");
    if (actionsValue.IsArray()) {
      Napi::Array actions = actionsValue.As<Napi::Array>();
      for (uint32_t action = 0; action < actions.Length(); action++) {
        Napi::Value title = actions.Get(action);
        if (title.IsString()) {
          [actionTitles
              addObject:ToNSString(title.As<Napi::String>().Utf8Value())];
        }
      }
    }
    RememberCategory(categoryId, actionTitles);
  }
  ApplyCategories();
  return env.Undefined();
}

Napi::Value Show(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) {
    throw Napi::TypeError::New(
        env, "notifier.show(request, callback) requires an object and a "
             "function");
  }

  Napi::Object requestObject = info[0].As<Napi::Object>();
  ShowRequest request;
  request.id = RequiredString(requestObject, "id");
  request.title = RequiredString(requestObject, "title");
  request.subtitle = OptionalString(requestObject, "subtitle");
  request.body = RequiredString(requestObject, "body");
  request.categoryId = RequiredString(requestObject, "categoryId");

  Napi::Value actionsValue = requestObject.Get("actions");
  if (actionsValue.IsArray()) {
    Napi::Array actions = actionsValue.As<Napi::Array>();
    for (uint32_t index = 0; index < actions.Length(); index++) {
      Napi::Value action = actions.Get(index);
      if (action.IsString()) {
        request.actions.push_back(action.As<Napi::String>().Utf8Value());
      }
    }
  }

  Napi::Value senderValue = requestObject.Get("sender");
  if (senderValue.IsObject()) {
    Napi::Object sender = senderValue.As<Napi::Object>();
    request.hasSender = true;
    request.sender.id = RequiredString(sender, "id");
    request.sender.name = RequiredString(sender, "name");
    request.sender.avatarPngPath = RequiredString(sender, "avatarPngPath");
    request.sender.conversationId = OptionalString(sender, "conversationId");
  }

  Napi::ThreadSafeFunction tsfn = Napi::ThreadSafeFunction::New(
      env, info[1].As<Napi::Function>(), "vellum-notifier", 0, 1);
  // A notification awaiting a click must not hold the process open at quit.
  tsfn.Unref(env);
  RememberCallback(request.id, tsfn);

  if (!IsBundled()) {
    Event event;
    event.kind = "failed";
    event.error = "Notifications require a bundled app";
    EmitEvent(request.id, std::move(event), true);
    return env.Undefined();
  }

  EnsureDelegateInstalled();

  // Requesting authorization on every post is what makes the first
  // notification wait for the user's answer instead of silently failing.
  // After the first decision macOS answers from its stored setting without
  // prompting again.
  [[UNUserNotificationCenter currentNotificationCenter]
      requestAuthorizationWithOptions:UNAuthorizationOptionAlert |
                                      UNAuthorizationOptionSound |
                                      UNAuthorizationOptionBadge
                    completionHandler:^(BOOL granted, NSError *error) {
                      dispatch_async(dispatch_get_main_queue(), ^{
                        if (!granted) {
                          Event event;
                          event.kind = "failed";
                          event.error =
                              error != nil
                                  ? ToStdString(error.localizedDescription)
                                  : "Notifications are not authorized";
                          EmitEvent(request.id, std::move(event), true);
                          return;
                        }
                        PostNotification(request);
                      });
                    }];

  return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("isSupported", Napi::Function::New(env, IsSupported));
  exports.Set("requestAuthorization",
              Napi::Function::New(env, RequestAuthorization));
  exports.Set("registerCategories",
              Napi::Function::New(env, RegisterCategories));
  exports.Set("ensureDelegate", Napi::Function::New(env, EnsureDelegate));
  exports.Set("restoreDelegate",
              Napi::Function::New(env, RestoreDelegateBinding));
  exports.Set("show", Napi::Function::New(env, Show));
  return exports;
}

}  // namespace

NODE_API_MODULE(vellum_notifier, Init)
