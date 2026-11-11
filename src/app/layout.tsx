import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Rezerwacje lekcji',
  description: 'Rezerwacje lekcji indywidualnych',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pl">
      <body>
        <header className="top">Rezerwacje lekcji</header>
        <div className="page">{children}</div>
      </body>
    </html>
  );
}
