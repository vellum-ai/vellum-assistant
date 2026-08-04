#if __has_include(<Sentry/Sentry.h>)
#    import <Sentry/SentryDefines.h>
#elif __has_include(<SentryWithoutUIKit/Sentry.h>)
#    import <SentryWithoutUIKit/SentryDefines.h>
#else
#    import <SentryDefines.h>
#endif
#import SENTRY_HEADER(SentrySerializable)

NS_ASSUME_NONNULL_BEGIN

@class SentryStacktrace;

@interface SentryThread : NSObject <SentrySerializable>

SENTRY_NO_INIT

/**
 * Number of the thread.
 *
 * Can be nil for threads in recrash reports where the thread index information is not available.
 */
@property (nullable, nonatomic, copy) NSNumber *threadId;

/**
 * Name (if available) of the thread
 */
@property (nullable, nonatomic, copy) NSString *name;

/**
 * SentryStacktrace of the SentryThread
 */
@property (nullable, nonatomic, strong) SentryStacktrace *stacktrace;

/**
 * Did this thread crash?
 */
@property (nullable, nonatomic, copy) NSNumber *crashed;

/**
 * Was it the current thread.
 */
@property (nullable, nonatomic, copy) NSNumber *current;

/**
 * Was it the main thread?
 */
@property (nullable, nonatomic, copy) NSNumber *isMain;

/**
 * Initializes a SentryThread with its id
 * @param threadId NSNumber or nil if thread index is not available (e.g., recrash reports)
 * @return SentryThread
 */
- (instancetype)initWithThreadId:(nullable NSNumber *)threadId;

@end

NS_ASSUME_NONNULL_END
