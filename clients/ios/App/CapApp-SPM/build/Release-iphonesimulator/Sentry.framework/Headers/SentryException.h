#import <Foundation/Foundation.h>
#if __has_include(<Sentry/Sentry.h>)
#    import <Sentry/SentryDefines.h>
#elif __has_include(<SentryWithoutUIKit/Sentry.h>)
#    import <SentryWithoutUIKit/SentryDefines.h>
#else
#    import <SentryDefines.h>
#endif
#import SENTRY_HEADER(SentrySerializable)

NS_ASSUME_NONNULL_BEGIN

@class SentryMechanism;
@class SentryStacktrace;

NS_SWIFT_NAME(Exception)
@interface SentryException : NSObject <SentrySerializable>

SENTRY_NO_INIT

/**
 * The name of the exception
 */
@property (nonatomic, copy) NSString *_Nullable value;

/**
 * Type of the exception
 */
@property (nonatomic, copy) NSString *_Nullable type;

/**
 * Additional information about the exception
 */
@property (nonatomic, strong) SentryMechanism *_Nullable mechanism;

/**
 * Can be set to define the module
 */
@property (nonatomic, copy) NSString *_Nullable module;

/**
 * An optional value which refers to a thread in @c SentryEvent.threads
 */
@property (nonatomic, copy) NSNumber *_Nullable threadId;

/**
 * Stacktrace containing frames of this exception.
 */
@property (nonatomic, strong) SentryStacktrace *_Nullable stacktrace;

/**
 * Initialize a SentryException with value and type.
 * @param value Nullable string describing the exception
 * @param type Nullable string with the type of the exception
 * @return SentryException
 * @note At least one of value or type must be non-nil. This is asserted in debug builds.
 */
- (instancetype)initWithValue:(NSString *_Nullable)value type:(NSString *_Nullable)type;

@end

NS_ASSUME_NONNULL_END
