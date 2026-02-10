import "./meadow.css";

export default function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <div className="app-root font-body">{children}</div>;
}
