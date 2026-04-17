import VellumAssistantShared

extension AuthManager {
    /// Performs WorkOS login, showing an error toast on failure.
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
            onSuccess?()
        }
    }
}
