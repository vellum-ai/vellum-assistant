import VellumAssistantShared

extension AuthManager {
    /// Performs logout, showing an error toast on HTTP failure or a success toast on clean logout.
    /// Clears `errorMessage` after toasting so inline displays don't double-show.
    func logoutWithToast(
        showToast: @escaping (String, ToastInfo.Style) -> Void
    ) async {
        await logout()
        if let error = errorMessage {
            showToast(error, .error)
            errorMessage = nil
        } else {
            showToast("Logged out. You can log in again from Settings.", .success)
        }
    }
}
