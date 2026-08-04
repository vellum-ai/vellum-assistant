#import "SentryCrash.h"
#import "SentryDefines.h"

@protocol SentryCrashReporter;
@class SentryDispatchQueueWrapper;
@class SentryInAppLogic;

NS_ASSUME_NONNULL_BEGIN

@interface SentryCrashReportSink : NSObject <SentryCrashReportFilter>
SENTRY_NO_INIT

- (instancetype)initWithInAppLogic:(SENTRY_SWIFT_MIGRATION_ID(SentryInAppLogic))inAppLogic
                      crashWrapper:(SENTRY_SWIFT_MIGRATION_ID(SentryCrashReporter))crashWrapper
                     dispatchQueue:
                         (SENTRY_SWIFT_MIGRATION_ID(SentryDispatchQueueWrapper))dispatchQueue;

@end

NS_ASSUME_NONNULL_END
