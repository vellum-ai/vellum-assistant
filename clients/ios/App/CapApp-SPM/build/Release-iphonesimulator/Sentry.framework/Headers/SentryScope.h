#if __has_include(<Sentry/Sentry.h>)
#    import <Sentry/SentryDefines.h>
#elif __has_include(<SentryWithoutUIKit/Sentry.h>)
#    import <SentryWithoutUIKit/SentryDefines.h>
#else
#    import <SentryDefines.h>
#endif
#import SENTRY_HEADER(SentrySerializable)
#import SENTRY_HEADER(SentrySpanProtocol)
#import SENTRY_HEADER(SentryLevel)

@class SentryAttachment;
@class SentryBreadcrumb;
@class SentryOptions;
@class SentryUser;

NS_ASSUME_NONNULL_BEGIN

/**
 * The scope holds useful information that should be sent along with the event. For instance tags or
 * breadcrumbs are stored on the scope.
 * @see
 * https://docs.sentry.io/platforms/apple/enriching-events/scopes/#whats-a-scope-whats-a-hub
 */
NS_SWIFT_NAME(Scope)
@interface SentryScope : NSObject <SentrySerializable>

/**
 * Returns current Span or Transaction.
 * @return current Span or Transaction or null if transaction has not been set.
 */
@property (nullable, nonatomic, strong) id<SentrySpan> span;

/**
 * The id of current session replay.
 */
@property (nullable, nonatomic, strong) NSString *replayId;

/**
 * Gets the dictionary of currently set tags.
 */
@property (nonatomic, readonly, copy) NSDictionary<NSString *, NSString *> *tags;

/**
 * Gets the dictionary of currently set attributes.
 */
@property (nonatomic, readonly, copy) NSDictionary<NSString *, id> *attributes;

- (instancetype)initWithMaxBreadcrumbs:(NSInteger)maxBreadcrumbs NS_DESIGNATED_INITIALIZER;
- (instancetype)init;
- (instancetype)initWithScope:(SentryScope *)scope;

/**
 * Set global user -> thus will be sent with every event
 */
- (void)setUser:(SentryUser *_Nullable)user;

/**
 * Set a global tag. Tags are searchable key/value string pairs attached to
 * every event.
 */
- (void)setTagValue:(NSString *)value forKey:(NSString *)key NS_SWIFT_NAME(setTag(value:key:));

/**
 * Remove the tag for the specified key.
 */
- (void)removeTagForKey:(NSString *)key NS_SWIFT_NAME(removeTag(key:));

/**
 * Set global tags. Tags are searchable key/value string pairs attached to every
 * event.
 */
- (void)setTags:(NSDictionary<NSString *, NSString *> *_Nullable)tags;

/**
 * Set global extra -> these will be sent with every event
 */
- (void)setExtras:(NSDictionary<NSString *, id> *_Nullable)extras;

/**
 * Set global extra -> these will be sent with every event
 */
- (void)setExtraValue:(id _Nullable)value
               forKey:(NSString *)key NS_SWIFT_NAME(setExtra(value:key:));

/**
 * Remove the extra for the specified key.
 */
- (void)removeExtraForKey:(NSString *)key NS_SWIFT_NAME(removeExtra(key:));

/**
 * Set @c dist in the scope
 */
- (void)setDist:(NSString *_Nullable)dist;

/**
 * Set @c environment in the scope
 */
- (void)setEnvironment:(NSString *_Nullable)environment;

/**
 * Sets the @c fingerprint in the scope
 */
- (void)setFingerprint:(NSArray<NSString *> *_Nullable)fingerprint;

/**
 * Sets the @c level in the scope
 */
- (void)setLevel:(SentryLevel)level;

/**
 * Add a breadcrumb to the scope
 */
- (void)addBreadcrumb:(SentryBreadcrumb *)crumb NS_SWIFT_NAME(addBreadcrumb(_:));

/**
 * Clears all breadcrumbs in the scope
 */
- (void)clearBreadcrumbs;

/**
 * Serializes the Scope to JSON
 */
- (NSDictionary<NSString *, id> *)serialize;

/**
 * Sets context values which will overwrite SentryEvent.context when event is
 * "enriched" with scope before sending event.
 * @note The @c flags context key is reserved for feature flag evaluations.
 */
- (void)setContextValue:(NSDictionary<NSString *, id> *)value
                 forKey:(NSString *)key NS_SWIFT_NAME(setContext(value:key:));

/**
 * Remove the context for the specified key.
 */
- (void)removeContextForKey:(NSString *)key NS_SWIFT_NAME(removeContext(key:));

/**
 * Adds an attachment to the Scope's list of attachments. The SDK adds the attachment to every event
 * sent to Sentry.
 * @param attachment The attachment to add to the Scope's list of attachments.
 */
- (void)addAttachment:(SentryAttachment *)attachment NS_SWIFT_NAME(addAttachment(_:));

/**
 * Set global attributes. Attributes are searchable key/value string pairs attached to every log
 * message.
 * @note The SDK only applies attributes to Logs. The SDK doesn't apply the attributes to
 * Events, Transactions, Spans, Profiles, Session Replay.
 * @param value Supported values are string, integers, boolean, double and arrays of those types
 * @param key The key to store, cannot be an empty string
 */
- (void)setAttributeValue:(id)value
                   forKey:(NSString *)key
    NS_SWIFT_NAME(setAttribute(value:key:)); // OK: bare id is needed to support multiple types

/**
 * Remove the attribute for the specified key.
 * @note The SDK only applies attributes to Logs. The SDK doesn't apply the attributes to
 * Events, Transactions, Spans, Profiles, Session Replay.
 * @param key The key to remove
 */
- (void)removeAttributeForKey:(NSString *)key NS_SWIFT_NAME(removeAttribute(key:));

/**
 * Clears all attachments in the scope.
 */
- (void)clearAttachments;

/**
 * Clears the current Scope
 */
- (void)clear;

@end

NS_ASSUME_NONNULL_END
