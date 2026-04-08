#import "include/ObjCExceptionCatcher.h"

BOOL VLMPerformWithObjCExceptionHandling(
    void (NS_NOESCAPE ^_Nonnull block)(void),
    NSError *_Nullable __autoreleasing *_Nullable outError
) {
    @try {
        block();
        return YES;
    } @catch (NSException *exception) {
        if (outError) {
            *outError = [NSError
                errorWithDomain:@"com.vellum.objc-exception"
                code:-1
                userInfo:@{
                    NSLocalizedDescriptionKey: exception.reason ?: @"Unknown Objective-C exception",
                    @"ExceptionName": exception.name ?: @"NSException"
                }];
        }
        return NO;
    }
}
