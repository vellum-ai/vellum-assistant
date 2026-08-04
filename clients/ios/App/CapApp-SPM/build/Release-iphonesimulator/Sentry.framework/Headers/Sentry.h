#if __has_include(<Sentry/Sentry.h>)
#    import <Foundation/Foundation.h>

//! Project version number for Sentry.
FOUNDATION_EXPORT double SentryVersionNumber;

//! Project version string for Sentry.
FOUNDATION_EXPORT const unsigned char SentryVersionString[];

#    import <Sentry/SentryAttachment.h>
#    import <Sentry/SentryBaggage.h>
#    import <Sentry/SentryBreadcrumb.h>
#    import <Sentry/SentryCrashExceptionApplication.h>
#    import <Sentry/SentryDebugMeta.h>
#    import <Sentry/SentryDefines.h>
#    import <Sentry/SentryError.h>
#    import <Sentry/SentryEvent.h>
#    import <Sentry/SentryException.h>
#    import <Sentry/SentryFrame.h>
#    import <Sentry/SentryGeo.h>
#    import <Sentry/SentryHttpStatusCodeRange.h>
#    import <Sentry/SentryId.h>
#    import <Sentry/SentryLevel.h>
#    import <Sentry/SentryMeasurementUnit.h>
#    import <Sentry/SentryMechanism.h>
#    import <Sentry/SentryMechanismContext.h>
#    import <Sentry/SentryMessage.h>
#    import <Sentry/SentryNSError.h>
#    import <Sentry/SentryReplayApi.h>
#    import <Sentry/SentryRequest.h>
#    import <Sentry/SentrySampleDecision.h>
#    import <Sentry/SentrySamplingContext.h>
#    import <Sentry/SentryScope.h>
#    import <Sentry/SentrySerializable.h>
#    import <Sentry/SentrySpanContext.h>
#    import <Sentry/SentrySpanId.h>
#    import <Sentry/SentrySpanProtocol.h>
#    import <Sentry/SentrySpanStatus.h>
#    import <Sentry/SentryStacktrace.h>
#    import <Sentry/SentryThread.h>
#    import <Sentry/SentryTraceContext.h>
#    import <Sentry/SentryTraceHeader.h>
#    import <Sentry/SentryTransactionContext.h>
#    import <Sentry/SentryUser.h>
#    import <Sentry/SentryWithoutUIKit.h>

// Headers here are to be used by Hybrid SDKs
// Be careful when using them
#    import <Sentry/PrivateSentrySDKOnly.h>
#    import <Sentry/PrivatesHeader.h>
#    import <Sentry/SentryAppStartMeasurement.h>
#    import <Sentry/SentrySessionReplayHybridSDK.h>
#endif // __has_include(<Sentry/Sentry.h>)
