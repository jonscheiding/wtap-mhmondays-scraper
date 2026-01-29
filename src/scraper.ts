import axios from "axios";
import * as cheerio from "cheerio";
import * as fs from "fs/promises";
import * as path from "path";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import puppeteer from "puppeteer";

const execFileAsync = promisify(execFile);

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), ".data");
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "chromium";
const SEARCH_URL =
  "https://www.wtap.com/search/?query=mental%20health%20mondays";

interface VideoInfo {
  title: string;
  url: string;
  videoUrl?: string;
}

interface VideoStream {
  stream_type?: string;
  url?: string;
}

interface VideoMetadata {
  streams?: VideoStream[];
}

async function ensureDataDir(): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (error) {
    console.error("Failed to create .data directory:", error);
  }
}

async function fetchPage(url: string): Promise<string> {
  try {
    const response = await axios.get<string>(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
    });
    return response.data;
  } catch (error) {
    console.error(`Failed to fetch ${url}:`, error);
    throw error;
  }
}

async function searchForVideos(): Promise<VideoInfo[]> {
  console.log("Fetching search results from:", SEARCH_URL);

  let browser;
  try {
    // Use Puppeteer to render JavaScript-heavy page
    browser = await puppeteer.launch({
      headless: true,
      executablePath: CHROMIUM_PATH,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    await page.goto(SEARCH_URL, { waitUntil: "networkidle2", timeout: 30000 });

    // Wait for search results to load
    await page.waitForSelector("#resultdata", { timeout: 5000 }).catch(() => {
      console.log("Result data container not found, proceeding anyway");
    });

    // Get the page content
    const html = await page.content();
    const $ = cheerio.load(html);

    const videos: VideoInfo[] = [];

    // Look for links that match "Mental Health Mondays, Ep N" pattern
    $("a").each((_index, element) => {
      const title = $(element).text().trim();
      const href = $(element).attr("href");

      if (
        title.match(/Mental\s+Health\s+Mondays,?\s+(?:Ep\.?\s+)?\d+/i) &&
        href
      ) {
        const url = href.startsWith("http")
          ? href
          : new URL(href, "https://www.wtap.com").href;

        // Avoid duplicates
        if (!videos.some((v) => v.url === url)) {
          videos.push({ title, url });
        }
      }
    });

    console.log(`Found ${videos.length} Mental Health Mondays episodes`);
    return videos;
  } catch (error) {
    console.error("Error during search:", error);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function extractVideoUrl(pageUrl: string): Promise<string | null> {
  console.log(`Extracting video URL from: ${pageUrl}`);
  const html = await fetchPage(pageUrl);

  // Extract video data from Fusion metadata JSON
  const metadataMatch = html.match(/Fusion\.globalContent=({.*?});/s);
  if (metadataMatch) {
    try {
      const metadata = JSON.parse(metadataMatch[1]) as VideoMetadata;

      // Look for MP4 video streams (highest quality)
      if (metadata.streams && Array.isArray(metadata.streams)) {
        // Find the highest quality MP4 stream
        const mp4Stream = metadata.streams.find(
          (stream) => stream.stream_type === "mp4",
        );
        if (mp4Stream?.url) {
          return mp4Stream.url;
        }

        // Fall back to HLS stream if no MP4
        const hlsStream = metadata.streams.find(
          (stream) => stream.stream_type === "ts",
        );
        if (hlsStream?.url) {
          return hlsStream.url;
        }
      }
    } catch (error) {
      console.warn("Failed to parse video metadata:", error);
    }
  }

  // Fallback to HTML parsing methods
  const $ = cheerio.load(html);

  // Look for video sources - common patterns on news sites
  // Check for <video> tags
  const videoSrc = $("video source").attr("src");
  if (videoSrc) return videoSrc;

  // Check for iframe with video sources
  const iframeSrc = $("iframe").attr("src");
  if (iframeSrc) {
    // If it's a YouTube or other embedded video, return the iframe src
    if (iframeSrc.includes("youtube") || iframeSrc.includes("vimeo")) {
      return iframeSrc;
    }
  }

  // Check for data-video-src attributes
  const dataVideoSrc = $("[data-video-src]").attr("data-video-src");
  if (dataVideoSrc) return dataVideoSrc;

  // Check for video-related data attributes
  const videoElement = $("[data-video-id], [data-video-url]");
  if (videoElement.length > 0) {
    const url =
      videoElement.attr("data-video-url") || videoElement.attr("data-video-id");
    if (url) return url;
  }

  console.warn("Could not find video URL in page");
  return null;
}

async function downloadVideo(
  videoUrl: string,
  filename: string,
): Promise<boolean> {
  const filePath = path.join(DATA_DIR, filename);
  const audioPath = path.join(DATA_DIR, filename.replace(/\.mp4$/i, ".mp3"));

  // Check if audio file already exists (no need to re-download/convert)
  try {
    await fs.stat(audioPath);
    console.log(`Audio already exists: ${path.basename(audioPath)}`);
    return false; // Don't call extractAudio since audio is already done
  } catch {
    // Audio doesn't exist, check for video
  }

  // Check if video file already exists
  try {
    await fs.stat(filePath);
    console.log(`Video already exists: ${filename}`);
    return true; // Return true so extractAudio will be called
  } catch {
    // Video doesn't exist, proceed with download
  }

  try {
    console.log(`Downloading video to: ${filePath}`);
    const response = await axios.get(videoUrl, {
      responseType: "stream",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
      timeout: 60000,
    });

    await pipeline(response.data, createWriteStream(filePath));
    console.log(`Successfully downloaded: ${filename}`);
    return true;
  } catch (error) {
    console.error(`Failed to download video: ${filename}`, error);
    // Try to clean up partial file
    try {
      await fs.unlink(filePath);
    } catch {
      // Ignore cleanup errors
    }
    return false;
  }
}

function sanitizeFilename(title: string): string {
  // Extract episode number from title
  // Handle formats like "Mental Health Mondays, Ep. 2" and "Mental Health Mondays, Ep 2"
  const epMatch = title.match(/Ep\.?\s*(\d+)/i);
  const epNum = epMatch ? epMatch[1] : new Date().toISOString().slice(0, 10);
  return `Mental-Health-Mondays-Ep${epNum}.mp4`;
}

async function extractAudio(videoFilename: string): Promise<boolean> {
  const videoPath = path.join(DATA_DIR, videoFilename);
  const audioPath = path.join(
    DATA_DIR,
    videoFilename.replace(/\.mp4$/i, ".mp3"),
  );

  try {
    console.log(`Extracting audio from: ${videoFilename}`);
    await execFileAsync("ffmpeg", [
      "-i",
      videoPath,
      "-q:a",
      "9",
      "-map",
      "a",
      audioPath,
      "-y",
    ]);

    // Delete the original video file
    await fs.unlink(videoPath);
    console.log(`Successfully extracted audio to: ${path.basename(audioPath)}`);
    return true;
  } catch (error) {
    console.error(`Failed to extract audio from ${videoFilename}:`, error);
    return false;
  }
}

async function main(): Promise<void> {
  try {
    await ensureDataDir();

    const videos = await searchForVideos();

    if (videos.length === 0) {
      console.log("No Mental Health Mondays episodes found");
      return;
    }

    for (const video of videos) {
      console.log(`\nProcessing: ${video.title}`);

      const videoUrl = await extractVideoUrl(video.url);
      if (!videoUrl) {
        console.warn(`Skipping ${video.title} - could not extract video URL`);
        continue;
      }

      const filename = sanitizeFilename(video.title);
      const downloaded = await downloadVideo(videoUrl, filename);

      if (downloaded) {
        await extractAudio(filename);
      }
    }

    console.log("\nScraping complete!");
  } catch (error) {
    console.error("Fatal error:", error);
    process.exit(1);
  }
}

void main();
