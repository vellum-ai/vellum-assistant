#if __has_include(<Sentry/SentryProfilingConditionals.h>)
#    import <Sentry/SentryProfilingConditionals.h>
#else
#    import "SentryProfilingConditionals.h"
#endif

#if __has_include(<Sentry/SentrySDKInternal.h>)
#    import <Sentry/SentrySDKInternal.h>
#else
#    import "SentrySDKInternal.h"
#endif

@class SentryAppStartMeasurement;
@class SentryEnvelope;
@class SentryFeedback;
@class SentryOptions;
@class SentryId;
@class SentryHubInternal;

NS_ASSUME_NONNULL_BEGIN

@interface SentrySDKInternal ()

+ (void)captureFatalEvent:(SentryEvent *)event;

+ (void)captureFatalEvent:(SentryEvent *)event withScope:(SentryScope *)scope;

#if SENTRY_HAS_UIKIT
+ (void)captureFatalAppHangEvent:(SentryEvent *)event;
#endif // SENTRY_HAS_UIKIT

/**
 * SDK private field to store the state if onLastRunStatusDetermined (or the deprecated
 * onCrashedLastRun) callback was already called for the current SDK lifecycle.
 */
@property (nonatomic, class) BOOL lastRunStatusCalled;

/**
 * Set to @c YES after the crash reporter has been installed and has loaded its persisted state
 * from disk. This allows @c lastRunStatus to return a definitive answer instead of
 * @c SentryLastRunStatusUnknown.
 */
@property (nonatomic, class) BOOL crashReporterInstalled;

/**
 * Set to @c YES by any integration that detects a fatal event from the previous run
 * (crash reporter, watchdog termination). The integration installer checks this flag
 * to decide whether to fire @c onLastRunStatusDetermined with @c didNotCrash.
 */
@property (nonatomic, class) BOOL fatalDetected;

+ (void)setDetectedStartUpCrash:(BOOL)value;

+ (void)setAppStartMeasurement:(nullable SentryAppStartMeasurement *)appStartMeasurement;

+ (nullable SentryAppStartMeasurement *)getAppStartMeasurement;

@property (nonatomic, class) NSUInteger startInvocations;
@property (nullable, nonatomic, class) NSDate *startTimestamp;

+ (SentryHubInternal *)currentHub;

/**
 * The option used to start the SDK
 */
@property (nonatomic, nullable, readonly, class) SentryOptions *options;

/**
 * Needed by hybrid SDKs as react-native to synchronously store an envelope to disk.
 */
+ (void)storeEnvelope:(SentryEnvelope *)envelope;

/**
 * Needed by hybrid SDKs as react-native to synchronously capture an envelope.
 */
+ (void)captureEnvelope:(SentryEnvelope *)envelope;

#if SENTRY_HAS_UIKIT

/** Only needed for testing. We can't use `SENTRY_TEST || SENTRY_TEST_CI` because we call this from
 * the iOS-Swift sample app. */
+ (nullable NSArray<NSString *> *)relevantViewControllersNames;

#endif // SENTRY_HAS_UIKIT

@end

NS_ASSUME_NONNULL_END
