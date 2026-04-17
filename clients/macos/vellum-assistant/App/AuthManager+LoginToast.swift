import VellumAssistantShared

extension AuthManager {
    /// Performs WorkOS login, showing an error toast on failure.
    /// On success, resumes the current assistant session before any caller-specific
    /// follow-up so local bootstrap and managed reconnect happen consistently.
    /// Clears `errorMessage` after toasting so inline displays don't double-show.
    func loginWithToast(
        showToast: @escaping (String, ToastInfo.Style) -> Void,
        onSuccess: (() -> Void)? = nil
    ) async {
        await startWorkOSLogin()
        if let error = errorMessage {
            showToast(error, .error)
            errorMessage = nil
        } else if isAuthenticated {
            AppDelegate.shared?.resumeAuthenticatedAssistantSessionIfNeeded()
            onSuccess?()
        }
    }
}
