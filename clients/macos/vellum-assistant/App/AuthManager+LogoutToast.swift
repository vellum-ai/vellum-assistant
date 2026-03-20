import VellumAssistantShared

extension AuthManager {
    /// Performs logout, showing an error toast on HTTP failure or a success toast on clean logout.
    func logoutWithToast(
        showToast: @escaping (String, ToastInfo.Style) -> Void
    ) async {
        let error = await logout()
        if let error {
            showToast(error, .error)
        } else {
            showToast("Logged out. You can log in again from Settings.", .success)
        }
    }
}
