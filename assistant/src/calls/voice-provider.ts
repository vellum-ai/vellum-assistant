export interface InitiateCallOptions {
  from: string;
  to: string;
  webhookUrl: string;
  statusCallbackUrl: string;
  customParams?: Record<string, string>;
}

export interface VoiceProvider {
  name: string;
  initiateCall(opts: InitiateCallOptions): Promise<{ callSid: string }>;
  endCall(callSid: string): Promise<void>;
  getCallStatus(callSid: string): Promise<string>;
}
