#if __has_include(<Sentry/Sentry.h>)
#    import <Sentry/SentryDefines.h>
#elif __has_include(<SentryWithoutUIKit/Sentry.h>)
#    import <SentryWithoutUIKit/SentryDefines.h>
#else
#    import <SentryDefines.h>
#endif
#import SENTRY_HEADER(SentrySerializable)

NS_ASSUME_NONNULL_BEGIN

@class SentryBaggage;
@class SentryId;
@class SentryOptions;
@class SentryScope;
@class SentryTracer;
@class SentryUser;

NS_SWIFT_NAME(TraceContext)
@interface SentryTraceContext : NSObject <SentrySerializable>

/**
 * UUID V4 encoded as a hexadecimal sequence with no dashes (e.g. 771a43a4192642f0b136d5159a501700)
 * that is a sequence of 32 hexadecimal digits.
 */
@property (nonatomic, readonly) SentryId *traceId;

/**
 * Public key from the DSN used by the SDK.
 */
@property (nonatomic, readonly) NSString *publicKey;

/**
 * The release name as specified in client options, usually: package@x.y.z+build.
 */
@property (nullable, nonatomic, readonly) NSString *releaseName;

/**
 * The environment name as specified in client options, for example staging.
 */
@property (nullable, nonatomic, readonly) NSString *environment;

/**
 * The transaction name set on the scope.
 */
@property (nullable, nonatomic, readonly) NSString *transaction;

/**
 * Serialized sample rate used for this trace.
 */
@property (nullable, nonatomic, readonly) NSString *sampleRate;

/**
 * Serialized random value used to determine if the trace is sampled.
 */
@property (nullable, nonatomic, readonly) NSString *sampleRand;

/**
 * Value indicating whether the trace was sampled.
 */
@property (nullable, nonatomic, readonly) NSString *sampled;

/**
 * Id of the current session replay.
 */
@property (nullable, nonatomic, readonly) NSString *replayId;

/**
 * The organization ID extracted from the DSN or configured explicitly.
 */
@property (nullable, nonatomic, readonly) NSString *orgId;

/**
 * Create a SentryBaggage with the information of this SentryTraceContext.
 */
- (SentryBaggage *)toBaggage;
@end

NS_ASSUME_NONNULL_END
