import { NextRequest, NextResponse } from "next/server";
import { safeFetchText } from "@/lib/safe-fetch";

// Fetch a URL with native fetch
async function fetchWithNativeFetch(url: string) {
  try {
    const result = await safeFetchText(url);
    return { textContent: result.textContent, resolvedUrl: result.resolvedUrl, title: "" };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "抓取失败" };
  }
}

// For Coze share links, use native fetch to follow redirect and get fresh signed URL
async function fetchCozeShareLink(shareUrl: string) {
  try {
    const result = await safeFetchText(shareUrl);
    return { textContent: result.textContent, redirectUrl: result.resolvedUrl, title: "" };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "抓取失败";
    return { error: msg };
  }
}

// Check if the response is a TOS error (ExpiredToken, AccessDenied, etc.)
function isTosErrorResponse(text: string): boolean {
  try {
    const parsed = JSON.parse(text.trim());
    if (parsed.Code && parsed.Message && parsed.RequestId) {
      return true; // TOS error format
    }
  } catch {
    // Not JSON, not a TOS error
  }
  return false;
}

function extractJsonFromText(textContent: string): string | null {
  // Strategy 1: Entire text is JSON
  try {
    const parsed = JSON.parse(textContent.trim());
    // Skip TOS error responses
    if (parsed.Code && parsed.Message && parsed.RequestId) {
      // This is a TOS error, not real data
    } else {
      return textContent.trim();
    }
  } catch {
    // Not valid JSON
  }

  // Strategy 2: Find JSON array or object in the text
  const jsonPatterns = [
    /\[[\s\S]*?\](?=\s*$|\s*[^,\[\]{}"\w])/,
    /\{[\s\S]*?\}(?=\s*$|\s*[^,\[\]{}"\w])/,
  ];

  for (const pattern of jsonPatterns) {
    const match = textContent.match(pattern);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        // Skip TOS error responses
        if (parsed.Code && parsed.Message && parsed.RequestId) continue;
        return match[0];
      } catch {
        // Not valid JSON, continue trying
      }
    }
  }

  // Strategy 3: Look for JSON in code blocks
  const codeBlockMatch = textContent.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (!(parsed.Code && parsed.Message && parsed.RequestId)) {
        return codeBlockMatch[1].trim();
      }
    } catch {
      // Not valid JSON
    }
  }

  return null;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const url = body.url;
    if (typeof url !== "string" || !url) {
      return NextResponse.json({ error: "缺少有效 URL 参数" }, { status: 400 });
    }

    let textContent = "";
    let resolvedUrl = url;
    let title = "";

    // Detect Coze share links - use native fetch for better redirect handling
    const isCozeShareLink = /coze\.cn\/s\//.test(url);

    if (isCozeShareLink) {
      // Try native fetch for Coze share links (gets fresh signed URL)
      const cozeResult = await fetchCozeShareLink(url);

      // Extract date from redirect URL even if fetch failed
      const redirectUrl = cozeResult.redirectUrl || "";
      const dateFromUrl = redirectUrl.match(/(\d{8})\.json/);

      if (cozeResult.error && !cozeResult.textContent) {
        // Native fetch failed completely
        return NextResponse.json(
          {
            error: `Coze分享链接抓取失败: ${cozeResult.error}。请在浏览器中打开链接，复制JSON内容后粘贴到下方。`,
            detectedDate: dateFromUrl ? dateFromUrl[1] : "",
          },
          { status: 500 }
        );
      }

      textContent = cozeResult.textContent || "";
      resolvedUrl = redirectUrl || url;

      // If TOS token expired, return helpful error with detected date
      const extractedJson = extractJsonFromText(textContent);
      if (!extractedJson && isTosErrorResponse(textContent)) {
        return NextResponse.json(
          {
            error: "Coze分享链接的签名已过期，服务端无法获取文件。请在浏览器中打开链接，复制JSON内容后粘贴到下方。",
            detectedDate: dateFromUrl ? dateFromUrl[1] : "",
          },
          { status: 500 }
        );
      }

      title = cozeResult.title || "";
    } else {
      // Non-Coze URLs: use native fetch
      const fetchResult = await fetchWithNativeFetch(url);
      if (fetchResult.error) {
        return NextResponse.json({ error: fetchResult.error }, { status: 500 });
      }
      textContent = fetchResult.textContent || "";
      resolvedUrl = fetchResult.resolvedUrl || url;
      title = fetchResult.title || "";
    }

    const extractedJson = extractJsonFromText(textContent);

    // Extract date from resolved URL
    const dateMatch = resolvedUrl.match(/(\d{8})\.json/);
    const detectedDate = dateMatch ? dateMatch[1] : "";

    return NextResponse.json({
      success: true,
      title,
      url: resolvedUrl,
      textContent: textContent.slice(0, 500),
      extractedJson,
      detectedDate,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "抓取失败";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
