#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Executes a block and catches any Objective-C exception, converting it to an NSError.
/// Returns YES on success, NO if an exception was caught.
///
/// Use this to guard Apple framework calls that throw NSException instead of returning
/// Swift-compatible errors (e.g. AVAudioNode.installTap which raises
/// NSInternalInconsistencyException on format mismatch).
FOUNDATION_EXPORT BOOL VLMPerformWithObjCExceptionHandling(
    void (NS_NOESCAPE ^_Nonnull block)(void),
    NSError *_Nullable __autoreleasing *_Nullable outError
);

NS_ASSUME_NONNULL_END
