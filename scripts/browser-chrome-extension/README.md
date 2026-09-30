# Shale Browser Ingestor - Chrome Extension (Manifest V3)

A Chrome extension to ingest active web pages, browser history, bookmarks, and browsing sessions into your local [Shale](https://github.com/munch/shale) knowledge graph.

---

## Features

- **Initial Data Import & Bootstrap**:
  - Automatically prompts on first run to bootstrap your knowledge graph with existing bookmarks, open tabs, and past browsing history.
  - Paginated batch streaming for history across selectable time horizons:
    - **Last 24 Hours**
    - **Last 7 Days**
    - **Last 30 Days**
    - **Last 90 Days**
    - **All Time (Full History)**
  - Manual trigger button available anytime for testing, partial re-syncs, or recovering from connection errors.
  - "Reset Onboarding State" button to easily reset sync flags for development and testing.
- **Live Active Page Sync**: Captures pages as you browse, extracts clean readable content, and sends them to the Shale server.
- **Explicit Session Grouping**: Tracks real navigation trails within cohesive research sessions (`WebSession`). Manual captures and open-tab snapshots are indexed without being mistaken for navigation.
- **History Sync**: Ingests your recent browser history with domain relationships and deduplication.
- **Bookmarks Sync**: Extracts your bookmark hierarchy into `BookmarkFolder` knowledge graph entities.
- **Privacy & Collision Avoidance**: Automatically excludes social media apps (Twitter/X, Reddit, Instagram, Facebook, TikTok, LinkedIn) and private sites (Google Account login, webmail, banking) with customizable rules.
- **Popup Control Panel**: Quick actions to ingest the active tab, ingest all open tabs, sync history, sync bookmarks, and adjust settings.

---

## Installation Instructions

1. Open **Google Chrome** (or Brave / Chromium / Edge).
2. Navigate to `chrome://extensions/` in the address bar.
3. Enable **Developer mode** using the toggle switch in the top-right corner.
4. Click **Load unpacked** in the top-left corner.
5. Select the browser extension directory inside this repository:
   ```text
   /home/munch/Projects/shale/scripts/browser-chrome-extension
   ```
6. The **Shale Browser Ingestor** extension icon will appear in your Chrome toolbar. Pin it for quick access!

---

## Initial Setup & Full Import

When you first open the extension popup:
1. Ensure your Shale server is running (`bun main/index.ts` on port 7425). The status indicator will turn **Connected** (green dot).
2. You will see the **Initial Data Import** banner. Click **Run Full Initial Import** to import your open tabs, bookmarks, and the past 7 days of history.
3. If you want to import older history (e.g. **Last 30 Days** or **All Time**), use the **Data Import & Bootstrap** card:
   - Select your desired history timeframe from the dropdown.
   - Click **Start Full Import**.
   - Watch the live progress bar and counts update in real-time.

### What each import contains

- **Open tabs / active page:** visible readable text, capped page HTML, outbound links, image URLs and alt text, author metadata, favicon, and tab/session metadata. Shale's web-page parser can use the HTML and image URLs for image analysis.
- **Bookmarks:** URL, title, bookmark folder, and date added.
- **History:** URL, title, last visit time, visit count, and typed count.

Chrome's bookmarks and history APIs do not provide archived page HTML or images. To capture rich content for those URLs, open the pages and use **Capture this page** or **Capture open tabs**.

Page captures, history records, and bookmarks are stored as separate source records, while all three point to the same canonical URL node in the graph. This preserves rich captured content during later history/bookmark syncs. Session state also survives Manifest V3 service-worker restarts.

---

## Manual Triggering & Testing

To test or re-import data at any time:
- In the **Data Import & Bootstrap** card:
  - Check or uncheck **Open Tabs**, **Bookmarks**, or **Past History**.
  - Choose any timeframe (**24h**, **7d**, **30d**, **90d**, **All Time**).
  - Click **Start Full Import**.
- To reset the initial onboarding prompt for testing, click **Reset Onboarding State** at the bottom of the card.
