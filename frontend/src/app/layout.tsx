import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'CAD Compliance Auditor',
  description:
    'Inspect STEP and IFC models against engineering requirements and highlight non-compliant components in 3D.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
