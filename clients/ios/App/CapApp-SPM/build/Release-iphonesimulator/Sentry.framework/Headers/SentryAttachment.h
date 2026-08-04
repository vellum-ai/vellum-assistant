#if __has_include(<Sentry/Sentry.h>)
#    import <Sentry/SentryDefines.h>
#elif __has_include(<SentryWithoutUIKit/Sentry.h>)
#    import <SentryWithoutUIKit/SentryDefines.h>
#else
#    import <SentryDefines.h>
#endif

NS_ASSUME_NONNULL_BEGIN

/**
 * Attachment Type
 *
 * This enum specifies the type of attachment. The attachment type is primarily used by downstream
 * SDKs (such as sentry-godot) to distinguish between different attachment categories.
 * Most applications using the SDK directly do not need to specify this, as the default
 * @c kSentryAttachmentTypeEventAttachment is used for regular file attachments.
 *
 *
 * See also: https://develop.sentry.dev/sdk/data-model/envelope-items/#attachment
 */
typedef NS_ENUM(NSInteger, SentryAttachmentType) {
    /**
     * Standard event attachment. This is the default type for user-provided attachments.
     */
    kSentryAttachmentTypeEventAttachment,
    /**
     * View hierarchy attachment. Automatically set by the SDK when capturing view hierarchy data.
     * This type is primarily used by downstream SDKs.
     */
    kSentryAttachmentTypeViewHierarchy
};

/**
 * You can use an attachment to store additional files alongside an event.
 */
NS_SWIFT_NAME(Attachment)
@interface SentryAttachment : NSObject
SENTRY_NO_INIT

/**
 * Initializes an attachment with data. Sets the content type to @c "application/octet-stream".
 * @param data The data for the attachment.
 * @param filename The name of the attachment to display in Sentry.
 */
- (instancetype)initWithData:(NSData *)data filename:(NSString *)filename;

/**
 * Initializes an attachment with data.
 * @param data The data for the attachment.
 * @param filename The name of the attachment to display in Sentry.
 * @param contentType The content type of the attachment. @c Default is "application/octet-stream".
 */
- (instancetype)initWithData:(NSData *)data
                    filename:(NSString *)filename
                 contentType:(nullable NSString *)contentType;

/**
 * Initializes an attachment with a path. Uses the last path component of the path as a filename
 * and sets the content type to @c "application/octet-stream".
 * @discussion The file located at the pathname is read lazily when the SDK captures an event or
 * transaction not when the attachment is initialized.
 * @param path The path of the file whose contents you want to upload to Sentry.
 */
- (instancetype)initWithPath:(NSString *)path;

/**
 * Initializes an attachment with a path. Sets the content type to @c "application/octet-stream".
 * @discussion The specified file is read lazily when the SDK captures an event or
 * transaction not when the attachment is initialized.
 * @param path The path of the file whose contents you want to upload to Sentry.
 * @param filename The name of the attachment to display in Sentry.
 */
- (instancetype)initWithPath:(NSString *)path filename:(NSString *)filename;

/**
 * Initializes an attachment with a path.
 * @discussion The specified file is read lazily when the SDK captures an event or
 * transaction not when the attachment is initialized.
 * @param path The path of the file whose contents you want to upload to Sentry.
 * @param filename The name of the attachment to display in Sentry.
 * @param contentType The content type of the attachment. Default is @c "application/octet-stream".
 */
- (instancetype)initWithPath:(NSString *)path
                    filename:(NSString *)filename
                 contentType:(nullable NSString *)contentType;

/**
 * Initializes an attachment with data.
 * @param data The data for the attachment.
 * @param filename The name of the attachment to display in Sentry.
 * @param contentType The content type of the attachment. Default is @c "application/octet-stream".
 * @param attachmentType The type of the attachment. Default is @c "EventAttachment".
 */
- (instancetype)initWithData:(NSData *)data
                    filename:(NSString *)filename
                 contentType:(nullable NSString *)contentType
              attachmentType:(SentryAttachmentType)attachmentType;

/**
 * Initializes an attachment with data.
 * @param path The path of the file whose contents you want to upload to Sentry.
 * @param filename The name of the attachment to display in Sentry.
 * @param contentType The content type of the attachment. Default is @c "application/octet-stream".
 * @param attachmentType The type of the attachment. Default is@c  "EventAttachment".
 */
- (instancetype)initWithPath:(NSString *)path
                    filename:(NSString *)filename
                 contentType:(nullable NSString *)contentType
              attachmentType:(SentryAttachmentType)attachmentType;

/**
 * The data of the attachment.
 */
@property (readonly, nonatomic, strong, nullable) NSData *data;

/**
 * The path of the attachment.
 */
@property (readonly, nonatomic, copy, nullable) NSString *path;

/**
 * The filename of the attachment to display in Sentry.
 */
@property (readonly, nonatomic, copy) NSString *filename;

/**
 * The content type of the attachment.
 */
@property (readonly, nonatomic, copy, nullable) NSString *contentType;

/**
 * The type of the attachment.
 */
@property (readonly, nonatomic) SentryAttachmentType attachmentType;

@end

NS_ASSUME_NONNULL_END
