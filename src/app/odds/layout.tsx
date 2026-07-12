import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "实时赔率监控系统",
  description: "足球赔率实时监控 - 未开赛赛事追踪",
};

export default function OddsMonitorLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return children;
}
