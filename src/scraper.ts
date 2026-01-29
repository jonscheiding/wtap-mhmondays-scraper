import axios from "axios";
import * as cheerio from "cheerio";
import * as fs from "fs/promises";
import * as path from "path";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import puppeteer from "puppeteer";
import { parse as parseYAML, stringify as stringifyYAML } from "yaml";
import nodeID3, { type Tags } from "node-id3";

const execFileAsync = promisify(execFile);

// node-id3 is a CJS module; keep usage minimal and avoid type-level coupling

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), ".data");
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const SEARCH_URL =
  "https://www.wtap.com/wtap-plus/podcasts/mental-health-mondays/";
const GENERATE_YAML = /^(1|true)$/i.test(process.env.GENERATE_YAML ?? "false");
const YAML_OUTPUT_DIR =
  process.env.YAML_OUTPUT_DIR || path.join(process.cwd(), ".data");
const YAML_OUTPUT_FILE = process.env.YAML_OUTPUT_FILE || "episodes.yml";
const YAML_TEMPLATE_PATH =
  process.env.YAML_TEMPLATE_PATH || path.join(process.cwd(), "template.yml");

interface VideoMetadata {
  streams?: VideoStream[];
}

interface VideoInfo {
  title: string;
  url: string;
  videoUrl?: string;
}

interface VideoStream {
  stream_type?: string;
  url?: string;
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

    // Wait specifically for episode cards on the index page
    await page
      .waitForSelector("div.card-body", { timeout: 15000 })
      .catch(() => {
        console.log("Episode cards not found yet, proceeding anyway");
      });

    // Get the page content
    const html = await page.content();
    const $ = cheerio.load(html);

    const videos: VideoInfo[] = [];

    const isEpisodeUrl = (href: string): boolean => {
      try {
        const u = href.startsWith("http")
          ? new URL(href)
          : new URL(href, "https://www.wtap.com");
        // Exclude index and known non-episode paths
        if (u.href.replace(/\/?$/, "/") === SEARCH_URL) return false;
        if (u.pathname === "/homepage") return false;
        // Accept article-style URLs: /YYYY/MM/DD/slug/
        return /^\/\d{4}\/\d{2}\/\d{2}\//.test(u.pathname);
      } catch {
        return false;
      }
    };

    // Parse episode cards and extract links
    $("div.card-body").each((_i, card) => {
      const linkEl = $(card).find("a[href]").first();
      const href = linkEl.attr("href")?.trim();
      if (!href) return;

      // Require typical article date-path URLs
      if (!isEpisodeUrl(href)) return;

      const url = href.startsWith("http")
        ? href
        : new URL(href, "https://www.wtap.com").href;

      // Skip if it links back to the index itself
      if (url.replace(/\/?$/, "/") === SEARCH_URL) return;

      // Prefer heading text inside the card, then link text
      const title =
        $(card).find("h1, h2, h3").first().text().trim() ||
        linkEl.text().trim() ||
        "Mental Health Mondays";

      if (!videos.some((v) => v.url === url)) {
        videos.push({ title, url });
      }
    });

    // If nothing found (unexpected), fall back to any anchors on the page that look like article URLs
    if (videos.length === 0) {
      $("a[href]").each((_index, element) => {
        const href = $(element).attr("href")?.trim();
        if (!href) return;
        if (!isEpisodeUrl(href)) return;
        const url = href.startsWith("http")
          ? href
          : new URL(href, "https://www.wtap.com").href;

        const title = $(element).text().trim() || "Mental Health Mondays";
        if (!videos.some((v) => v.url === url)) {
          videos.push({ title, url });
        }
      });
    }

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

  // 1) Try to extract Arc/Fusion metadata JSON
  const metadataMatch = html.match(/Fusion\.globalContent=({[\s\S]*?});/);
  if (metadataMatch) {
    try {
      const metadata = JSON.parse(metadataMatch[1]) as VideoMetadata;
      if (metadata.streams && Array.isArray(metadata.streams)) {
        const mp4Stream = metadata.streams.find((s) => s.stream_type === "mp4");
        if (mp4Stream?.url) return mp4Stream.url;
        const hlsStream = metadata.streams.find((s) => s.stream_type === "ts");
        if (hlsStream?.url) return hlsStream.url;
      }
    } catch {
      // ignore JSON parse errors
    }
  }

  const $ = cheerio.load(html);

  // 2) Direct <video><source></source></video>
  const videoSrc = $("video source").attr("src") || $("video").attr("src");
  if (videoSrc) return videoSrc;

  // 3) Look for obvious media URLs in inline scripts
  const scriptsText = $("script")
    .map((_i, el) => $(el).html() || "")
    .get()
    .join("\n");

  // Common patterns: m3u8/mp4 URLs, jwplayer/players configs, generic file/src keys
  const urlFromScripts =
    scriptsText.match(
      /https?:\/\/[^"'\s>]+\.(?:m3u8|mp4)(?:\?[^"'\s>]*)?/i,
    )?.[0] ||
    scriptsText.match(
      /\b(?:file|src|source|url)\b\s*[:=]\s*["'](https?:[^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
    )?.[1];
  if (urlFromScripts) return urlFromScripts;

  // 4) Check data attributes commonly used by players
  const dataUrl =
    $("[data-video-src]").attr("data-video-src") ||
    $("[data-src]").attr("data-src") ||
    $("[data-url]").attr("data-url");
  if (dataUrl && /\.(?:m3u8|mp4)(?:\?|$)/i.test(dataUrl)) return dataUrl;

  // 5) Fallback to Puppeteer to capture dynamically loaded media URLs
  let browser: puppeteer.Browser | undefined;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: CHROMIUM_PATH,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    let capturedUrl: string | null = null;

    // Capture network media
    page.on("response", (resp) => {
      try {
        const u = resp.url();
        if (/\.(?:m3u8|mp4)(?:\?|$)/i.test(u) && resp.status() < 400) {
          if (!capturedUrl) capturedUrl = u;
        }
      } catch {
        // ignore
      }
    });

    await page.goto(pageUrl, { waitUntil: "networkidle2", timeout: 30000 });

    // Try DOM inspection after JS executes
    const domUrl = (await page.evaluate(() => {
      const s = document.querySelector<HTMLSourceElement>("video source");
      if (s?.src) return s.src;
      const v = document.querySelector("video");
      if (v?.src) return v.src;
      const i = document.querySelector("iframe");
      if (i?.src && (i.src.includes("youtube") || i.src.includes("vimeo")))
        return i.src;
      return null as unknown as string | null;
    })) as unknown as string | null;

    if (domUrl) return domUrl;
    if (capturedUrl) return capturedUrl;
  } catch {
    // ignore puppeteer issues
  } finally {
    if (browser) await browser.close();
  }

  console.warn("Could not find video URL in page");
  return null;
}

interface ArticleMeta {
  title?: string;
  description?: string;
  pubDate?: string;
}

async function fetchArticleMeta(pageUrl: string): Promise<ArticleMeta> {
  try {
    const html = await fetchPage(pageUrl);
    const $ = cheerio.load(html);

    const title =
      $("meta[property='og:title']").attr("content") || $("title").text();
    const description =
      $("meta[name='description']").attr("content") ||
      $("meta[property='og:description']").attr("content") ||
      undefined;

    const pubDate =
      $("meta[property='article:published_time']").attr("content") ||
      $("time[datetime]").attr("datetime") ||
      undefined;

    return { title: title?.trim(), description: description?.trim(), pubDate };
  } catch (error) {
    console.warn("Failed to fetch article metadata:", error);
    return {};
  }
}

async function setFileModTime(
  filePath: string,
  pubDate?: string,
): Promise<void> {
  if (!pubDate) return;
  const d = new Date(pubDate);
  if (Number.isNaN(d.getTime())) return;
  try {
    await fs.utimes(filePath, d, d);
    console.log(
      `Set file modification time for ${path.basename(filePath)} to ${d.toISOString()}`,
    );
  } catch (error) {
    console.warn(
      `Failed to set file modification time for ${path.basename(filePath)}`,
      error,
    );
  }
}

function tagAudio(audioPath: string, meta: ArticleMeta): boolean {
  try {
    const tags: Tags = {
      title: meta.title ?? undefined,
      artist: "WTAP",
      album: "Mental Health Mondays",
      comment: {
        language: "eng",
        text: meta.description ?? "",
      },
    };

    if (meta.pubDate) {
      const d = new Date(meta.pubDate);
      if (!Number.isNaN(d.getTime())) {
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        // Use ID3v2.4 recording time (yyyy or yyyy-MM or yyyy-MM-dd are valid)
        tags.recordingTime = `${yyyy}-${mm}-${dd}`;
        // Also set year for ID3v2.3 compatibility
        tags.year = String(yyyy);
        // Set ID3v2.3 date (DDMM)
        tags.date = `${dd}${mm}`;
      }
    }

    const success = nodeID3.update(tags, audioPath);
    if (success === true) {
      console.log(`Tagged audio: ${audioPath}`);
      return true;
    }

    console.warn(`Failed to write ID3 tags for ${audioPath}`);
    return false;
  } catch (error) {
    console.error(`Error tagging audio ${audioPath}:`, error);
    return false;
  }
}

type EpisodeYaml = {
  file: string;
  title: string;
  description: string;
  pub_date: string;
  explicit: boolean;
  season: number;
  episode: number;
  episode_type: "full" | "trailer" | "bonus";
};

type TemplateYaml = {
  name?: string;
  title?: string;
  "author-name"?: string;
  description?: string;
  language?: string;
  explicit?: boolean;
  episodes?: EpisodeYaml[];
  [k: string]: unknown;
};

async function readYamlTemplateOrExisting(
  outPath: string,
  templatePath: string,
): Promise<TemplateYaml> {
  try {
    const text = await fs.readFile(outPath, "utf8");
    return (parseYAML(text) as TemplateYaml) ?? {};
  } catch {
    // Fallback to template file in repo
    try {
      const text = await fs.readFile(templatePath, "utf8");
      return (parseYAML(text) as TemplateYaml) ?? {};
    } catch (err) {
      console.warn(
        "YAML template not found; creating a minimal structure",
        err,
      );
      return { episodes: [] };
    }
  }
}

function upsertEpisodes(
  doc: TemplateYaml,
  newEpisodes: Omit<EpisodeYaml, "episode">[],
): TemplateYaml {
  const episodes = Array.isArray(doc.episodes) ? [...doc.episodes] : [];
  const existingFiles = new Set(episodes.map((e) => e.file));
  const existingMax = episodes.reduce((m, e) => Math.max(m, e.episode || 0), 0);
  let next = existingMax + 1;

  for (const ep of newEpisodes) {
    // Skip if already present by filename
    if (existingFiles.has(ep.file)) continue;
    episodes.push({ ...ep, episode: next++ });
    existingFiles.add(ep.file);
  }

  // Sort by episode number to keep things tidy
  episodes.sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0));
  return { ...doc, episodes };
}

async function writeYaml(doc: TemplateYaml, outPath: string): Promise<void> {
  const yaml = stringifyYAML(doc);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, yaml, "utf8");
  console.log(`Wrote YAML episode list: ${outPath}`);
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

function buildFilenameFromPubDate(pubDate?: string): string {
  let dateStr: string | undefined;
  if (pubDate) {
    const d = new Date(pubDate);
    if (!Number.isNaN(d.getTime())) {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      dateStr = `${yyyy}-${mm}-${dd}`;
    }
  }
  if (!dateStr) {
    dateStr = new Date().toISOString().slice(0, 10);
  }
  return `Mental-Health-Mondays-${dateStr}.mp4`;
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

    const episodesForYaml: Omit<EpisodeYaml, "episode">[] = [];

    for (const video of videos) {
      console.log(`\nProcessing: ${video.title}`);

      const videoUrl = await extractVideoUrl(video.url);
      if (!videoUrl) {
        console.warn(`Skipping ${video.title} - could not extract video URL`);
        continue;
      }

      // Fetch article metadata first to derive filename from publication date
      const meta = await fetchArticleMeta(video.url);
      const filename = buildFilenameFromPubDate(meta.pubDate);
      const downloaded = await downloadVideo(videoUrl, filename);

      const audioPath = path.join(
        DATA_DIR,
        filename.replace(/\.mp4$/i, ".mp3"),
      );

      if (downloaded) {
        const extracted = await extractAudio(filename);
        if (!extracted) {
          console.warn(
            `Skipping tagging for ${filename} - audio extraction failed`,
          );
          continue;
        }
      }

      // Tag audio if it exists (reusing fetched metadata)
      try {
        await fs.stat(audioPath);
        tagAudio(audioPath, meta);
        await setFileModTime(audioPath, meta.pubDate);

        if (GENERATE_YAML) {
          // Prepare YAML episode entry using available metadata
          const yamlEp: Omit<EpisodeYaml, "episode"> = {
            file: path.basename(audioPath),
            title: meta.title ?? "Mental Health Mondays",
            description: meta.description ?? "",
            pub_date: (meta.pubDate
              ? new Date(meta.pubDate)
              : new Date()
            ).toISOString(),
            explicit: false,
            season: 1,
            episode_type: "full",
          };
          episodesForYaml.push(yamlEp);
        }
      } catch {
        console.warn(`Audio file not found, skipping tag for ${filename}`);
      }
    }

    if (GENERATE_YAML && episodesForYaml.length > 0) {
      try {
        const outPath = path.join(YAML_OUTPUT_DIR, YAML_OUTPUT_FILE);
        const doc = await readYamlTemplateOrExisting(
          outPath,
          YAML_TEMPLATE_PATH,
        );

        // Sort new episodes by pub_date for deterministic numbering
        episodesForYaml.sort(
          (a, b) =>
            new Date(a.pub_date).getTime() - new Date(b.pub_date).getTime(),
        );
        const updated = upsertEpisodes(doc, episodesForYaml);
        await writeYaml(updated, outPath);
      } catch (err) {
        console.error("Failed to generate YAML file:", err);
      }
    }

    console.log("\nScraping complete!");
  } catch (error) {
    console.error("Fatal error:", error);
    process.exit(1);
  }
}

void main();
