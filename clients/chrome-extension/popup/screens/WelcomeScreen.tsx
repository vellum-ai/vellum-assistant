export interface WelcomeScreenProps {
  onSignIn: () => void;
  onSelfHosted: () => void;
}

export function WelcomeScreen({ onSignIn, onSelfHosted }: WelcomeScreenProps) {
  return (
    <div>
      <p>Welcome</p>
      <button onClick={onSignIn}>Sign in</button>
      <button onClick={onSelfHosted}>Self-hosted</button>
    </div>
  );
}
