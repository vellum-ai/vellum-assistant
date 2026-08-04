#if __has_include(<Sentry/SentryBreadcrumb.h>)
#    import <Sentry/SentryBreadcrumb.h>
#else
#    import "SentryBreadcrumb.h"
#endif

NS_ASSUME_NONNULL_BEGIN

@interface SentryBreadcrumb ()

- (instancetype)initWithLevel:(SentryLevel)level
                     category:(NSString *)category
                         data:(NSDictionary<NSString *, id> *)data;

- (instancetype _Nonnull)initWithDictionary:(NSDictionary *_Nonnull)dictionary;

- (SentryBreadcrumb *_Nonnull)snapshotCopy;
@end

NS_ASSUME_NONNULL_END
