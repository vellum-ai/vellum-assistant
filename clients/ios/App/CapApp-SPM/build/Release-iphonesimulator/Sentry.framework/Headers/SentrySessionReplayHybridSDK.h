#if __has_include(<Sentry/SentryDefines.h>)
#    import <Sentry/SentryDefines.h>
#else
#    import "SentryDefines.h"
#endif

#if __has_include(<Sentry/SentryLevel.h>)
#    import <Sentry/SentryLevel.h>
#else
#    import "SentryLevel.h"
#endif

NS_ASSUME_NONNULL_BEGIN
#if SENTRY_TARGET_REPLAY_SUPPORTED
@class SentryReplayOptions;

@protocol SentryViewScreenshotProvider;
@protocol SentryReplayBreadcrumbConverter;
@protocol SentryRRWebEvent;

@interface SentrySessionReplayHybridSDK : NSObject

+ (id<SentryRRWebEvent>)createBreadcrumbwithTimestamp:(NSDate *)timestamp
                                             category:(NSString *)category
                                              message:(nullable NSString *)message
                                                level:(SentryLevel)level
                                                 data:(nullable NSDictionary<NSString *, id> *)data;

+ (id<SentryRRWebEvent>)createNetworkBreadcrumbWithTimestamp:(NSDate *)timestamp
                                                endTimestamp:(NSDate *)endTimestamp
                                                   operation:(NSString *)operation
                                                 description:(NSString *)description
                                                        data:(NSDictionary<NSString *, id> *)data;

+ (id<SentryReplayBreadcrumbConverter>)createDefaultBreadcrumbConverter;

@end

#endif
NS_ASSUME_NONNULL_END
