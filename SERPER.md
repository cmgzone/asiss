# Google Search Integration (Serper API)

Gitu can now perform high-quality Google searches using the Serper API. This is superior to basic web scraping for finding current events, news, and specific answers.

## Setup

1.  Get a free API key from [serper.dev](https://serper.dev).
2.  Add it to your `.env` file:
    ```
    SERPER_API_KEY=your_key_here
    ```
3.  Restart Gitu.

## Usage

Agents can use the `serper_search` tool automatically when asked questions requiring internet access.

You can also test it via custom agents:

```
@researcher Find the latest news about SpaceX Starship
```

## Tool Capabilities

-   **Web Search**: Standard Google results with snippets.
-   **News Search**: Latest news articles.
-   **Image Search**: Find images.
-   **Answer Box**: Direct answers from Google's knowledge graph.
