#import <Foundation/Foundation.h>
#if __has_include(<Sentry/Sentry.h>)
#    import <Sentry/SentryDefines.h>
#elif __has_include(<SentryWithoutUIKit/Sentry.h>)
#    import <SentryWithoutUIKit/SentryDefines.h>
#else
#    import <SentryDefines.h>
#endif
#import SENTRY_HEADER(SentrySerializable)
#import SENTRY_HEADER(SentryLevel)

NS_ASSUME_NONNULL_BEGIN

NS_SWIFT_NAME(Breadcrumb)
@interface SentryBreadcrumb : NSObject <SentrySerializable>

/**
 * Level of breadcrumb
 */
@property (nonatomic) SentryLevel level;

/**
 * Category of bookmark, can be any string
 */
@property (nonatomic, copy) NSString *category;

/**
 * @c NSDate when the breadcrumb happened
 */
@property (nonatomic, strong, nullable) NSDate *timestamp;

/**
 * Type of breadcrumb, can be e.g.: http, empty, user, navigation
 * This will be used as icon of the breadcrumb
 */
@property (nonatomic, copy, nullable) NSString *type;

/**
 * Message for the breadcrumb
 */
@property (nonatomic, copy, nullable) NSString *message;

/**
 * Origin of the breadcrumb that is used to identify source of the breadcrumb
 * For example hybrid SDKs can identify native breadcrumbs from JS or Flutter
 */
@property (nonatomic, copy, nullable) NSString *origin;

/**
 * Arbitrary additional data that will be sent with the breadcrumb
 */
@property (nonatomic, copy, nullable) NSDictionary<NSString *, id> *data;

/**
 * @deprecated Use @c setDataValue:forKey: instead; the @c data property setter will become
 * read-only in a future release.
 */
- (void)setData:(nullable NSDictionary<NSString *, id> *)data
    __attribute__((deprecated("Use setData(value:key:) instead; the data property setter will "
                              "become read-only in a future release.")));

/**
 * Sets a single value in the breadcrumb's @c data dictionary for the given key.
 * Passing @c nil as the value removes the key. This is the preferred way of setting
 * breadcrumb data; the @c data property setter will become read-only in a future release.
 * @param value The value to store, or @c nil to remove the key.
 * @param key The key to set.
 */
- (void)setDataValue:(nullable id)value forKey:(NSString *)key NS_SWIFT_NAME(setData(value:key:));

/**
 * Initializer for @c SentryBreadcrumb
 * @param level SentryLevel
 * @param category String
 */
- (instancetype)initWithLevel:(SentryLevel)level category:(NSString *)category;
- (instancetype)init;
+ (instancetype)new NS_UNAVAILABLE;

- (NSDictionary<NSString *, id> *)serialize;

- (BOOL)isEqual:(id _Nullable)other;

- (BOOL)isEqualToBreadcrumb:(SentryBreadcrumb *)breadcrumb;

- (NSUInteger)hash;

@end

NS_ASSUME_NONNULL_END
