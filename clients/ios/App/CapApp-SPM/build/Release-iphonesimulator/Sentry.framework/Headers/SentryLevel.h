#import <Foundation/Foundation.h>

typedef NS_ENUM(NSUInteger, SentryLevel) {
    kSentryLevelNone = 0, // kSentryLevelNone
    kSentryLevelDebug = 1, // kSentryLevelDebug
    kSentryLevelInfo = 2, // kSentryLevelInfo
    kSentryLevelWarning = 3, // kSentryLevelWarning
    kSentryLevelError = 4, // kSentryLevelError
    kSentryLevelFatal = 5 // kSentryLevelFatal
};
