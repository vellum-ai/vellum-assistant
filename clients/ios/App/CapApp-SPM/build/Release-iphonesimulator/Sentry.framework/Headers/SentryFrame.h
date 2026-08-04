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

NS_SWIFT_NAME(Frame)
@interface SentryFrame : NSObject <SentrySerializable>

/**
 * SymbolAddress of the frame
 */
@property (nonatomic, copy) NSString *_Nullable symbolAddress;

/**
 * Filename is used only for reporting JS frames
 */
@property (nonatomic, copy) NSString *_Nullable fileName;

/**
 * Function name of the frame
 */
@property (nonatomic, copy) NSString *_Nullable function;

/**
 * Module of the frame, mostly unused
 */
@property (nonatomic, copy) NSString *_Nullable module;

/**
 * Corresponding package
 */
@property (nonatomic, copy) NSString *_Nullable package;

/**
 * ImageAddress if the image related to the frame
 */
@property (nonatomic, copy) NSString *_Nullable imageAddress;

/**
 * Set the platform for the individual frame, will use platform of the event.
 * Mostly used for react native crashes.
 */
@property (nonatomic, copy) NSString *_Nullable platform;

/**
 * InstructionAddress of the frame hex format
 */
@property (nonatomic, copy) NSString *_Nullable instructionAddress;

/**
 * User for react native, will be ignored for cocoa frames
 */
@property (nonatomic, copy) NSNumber *_Nullable lineNumber;

/**
 * User for react native, will be ignored for cocoa frames
 */
@property (nonatomic, copy) NSNumber *_Nullable columnNumber;

/**
 * Source code line at the error location.
 * Mostly used for Godot errors.
 */
@property (nonatomic, copy) NSString *_Nullable contextLine;

/**
 * Index of the parent frame used for flamegraphs.
 */
@property (nonatomic, copy) NSNumber *_Nullable parentIndex;

/**
 * Number of samples recorded that contained this frame, used for flamegraphs.
 */
@property (nonatomic, copy) NSNumber *_Nullable sampleCount;

/**
 * Source code lines before the error location (up to 5 lines).
 * Mostly used for Godot errors.
 */
@property (nonatomic, copy) NSArray<NSString *> *_Nullable preContext;

/**
 * Source code lines after the error location (up to 5 lines).
 * Mostly used for Godot errors.
 */
@property (nonatomic, copy) NSArray<NSString *> *_Nullable postContext;

/**
 * Determines if the Frame is inApp or not
 */
@property (nonatomic, copy) NSNumber *_Nullable inApp;

/**
 * Determines if the Frame is the base of an async continuation.
 */
@property (nonatomic, copy) NSNumber *_Nullable stackStart;

/**
 * A mapping of variables which were available within this frame.
 * Mostly used for Godot errors.
 */
@property (nonatomic, copy) NSDictionary<NSString *, id> *_Nullable vars;

- (instancetype)init;

@end

NS_ASSUME_NONNULL_END
