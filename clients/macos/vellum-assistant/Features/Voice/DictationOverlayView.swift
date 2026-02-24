enum DictationState {
    case recording
    case processing
    case transforming(String)
    case done
    case error(String)
}
