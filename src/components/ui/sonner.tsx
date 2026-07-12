"use client"

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      closeButton
      visibleToasts={4}
      gap={10}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--success-bg": "color-mix(in oklab, var(--success) 12%, var(--popover))",
          "--success-border": "color-mix(in oklab, var(--success) 42%, var(--border))",
          "--success-text": "var(--foreground)",
          "--error-bg": "color-mix(in oklab, var(--destructive) 14%, var(--popover))",
          "--error-border": "color-mix(in oklab, var(--destructive) 50%, var(--border))",
          "--error-text": "var(--foreground)",
          "--warning-bg": "color-mix(in oklab, var(--warning) 12%, var(--popover))",
          "--warning-border": "color-mix(in oklab, var(--warning) 45%, var(--border))",
          "--warning-text": "var(--foreground)",
          "--info-bg": "color-mix(in oklab, var(--info) 12%, var(--popover))",
          "--info-border": "color-mix(in oklab, var(--info) 42%, var(--border))",
          "--info-text": "var(--foreground)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
