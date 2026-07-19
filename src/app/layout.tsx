import type { Metadata } from 'next';
import { Toaster } from '@/components/ui/sonner';
import './globals.css';

export const metadata: Metadata = {
  title: '实时赔率监控系统',
  description: '足球赔率实时监控 - 未开赛赛事追踪',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="dark" suppressHydrationWarning>
      <body className={`antialiased`}>
        {children}
        <Toaster
          theme="dark"
          richColors
          closeButton
          expand
          visibleToasts={4}
          duration={4500}
          position="top-right"
        />
      </body>
    </html>
  );
}
