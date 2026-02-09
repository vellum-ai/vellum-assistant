import { FullNavBar } from "@/components/CommunityPage/_FullNavBar";
import { WorkflowCTA } from "@/components/VellumHomepage/WorkflowCTA";

const BENCHMARK_CATEGORIES = [
  {
    title: "Best in Reasoning (GPQA Diamond)",
    models: [
      { name: "GPT 5.2", score: "92.4" },
      { name: "Gemini 3 Pro", score: "91.9" },
      { name: "GPT 5.1", score: "88.1" },
      { name: "Grok 4", score: "87.5" },
      { name: "GPT-5", score: "87.3" },
    ],
  },
  {
    title: "Best in High School Math (AIME 2025)",
    models: [
      { name: "GPT 5.2", score: "100" },
      { name: "Gemini 3 Pro", score: "100" },
      { name: "Kimi K2 Thinking", score: "99.1" },
      { name: "GPT oss 20b", score: "98.7" },
      { name: "OpenAI o3", score: "98.4" },
    ],
  },
  {
    title: "Best in Agentic Coding (SWE Bench)",
    models: [
      { name: "Claude Sonnet 4.5", score: "82" },
      { name: "Claude Opus 4.5", score: "80.9" },
      { name: "GPT 5.2", score: "80" },
      { name: "GPT 5.1", score: "76.3" },
      { name: "Gemini 3 Pro", score: "76.2" },
    ],
  },
  {
    title: "Best Overall (Humanity's Last Exam)",
    models: [
      { name: "Gemini 3 Pro", score: "45.8" },
      { name: "Kimi K2 Thinking", score: "44.9" },
      { name: "GPT-5", score: "35.2" },
      { name: "Grok 4", score: "25.4" },
      { name: "Gemini 2.5 Pro", score: "21.6" },
    ],
  },
  {
    title: "Best in Visual Reasoning (ARC-AGI 2)",
    models: [
      { name: "Claude Opus 4.5", score: "378" },
      { name: "GPT 5.2", score: "53" },
      { name: "Gemini 3 Pro", score: "31" },
      { name: "GPT 5.1", score: "18" },
      { name: "GPT-5", score: "18" },
    ],
  },
  {
    title: "Best in Multilingual Reasoning (MMMLU)",
    models: [
      { name: "Gemini 3 Pro", score: "91.8" },
      { name: "Claude Opus 4.5", score: "90.8" },
      { name: "Claude Opus 4.1", score: "89.5" },
      { name: "Gemini 2.5 Pro", score: "89.2" },
      { name: "Claude Sonnet 4.5", score: "89.1" },
    ],
  },
];

const SPEED_CATEGORIES = [
  {
    title: "Fastest Models (Tokens/sec)",
    models: [
      { name: "Llama 4 Scout", score: "2600" },
      { name: "Llama 3.3 70b", score: "2500" },
      { name: "Llama 3.1 70b", score: "2100" },
      { name: "Llama 3.1 8b", score: "1800" },
      { name: "Llama 3.1 405b", score: "969" },
    ],
  },
  {
    title: "Lowest Latency (TTFT)",
    models: [
      { name: "Nova Micro", score: "0.3s" },
      { name: "Llama 3.1 8b", score: "0.32s" },
      { name: "Llama 4 Scout", score: "0.33s" },
      { name: "Gemini 2.0 Flash", score: "0.34s" },
      { name: "GPT-4o mini", score: "0.35s" },
    ],
  },
  {
    title: "Cheapest Models (per 1M tokens)",
    models: [
      { name: "Nova Micro", score: "$0.04 / $0.14" },
      { name: "Gemma 3 27b", score: "$0.07 / $0.07" },
      { name: "Gemini 1.5 Flash", score: "$0.075 / $0.3" },
      { name: "GPT oss 20b", score: "$0.08 / $0.35" },
    ],
  },
];

const MODEL_TABLE = [
  { name: "GPT 5.2", context: "400k", cutoff: "Aug 2025", cost: "$1.5 / $14", maxOutput: "16,000", latency: "0.6s", speed: "92 t/s" },
  { name: "Claude Opus 4.5", context: "200,000", cutoff: "April 2025", cost: "$5 / $25", maxOutput: "64,000", latency: "-", speed: "-" },
  { name: "Claude Sonnet 4.5", context: "200,000", cutoff: "April 2025", cost: "$3 / $15", maxOutput: "160,000", latency: "31s", speed: "69 t/s" },
  { name: "Gemini 3 Pro", context: "10,000,000", cutoff: "April 2025", cost: "$2 / $12", maxOutput: "650,000", latency: "30.3s", speed: "128 t/s" },
  { name: "Kimi K2 Thinking", context: "256,000", cutoff: "April 2025", cost: "$0.6 / $2.5", maxOutput: "16,400", latency: "25.3s", speed: "79 t/s" },
  { name: "GPT 5.1", context: "200,000", cutoff: "April 2025", cost: "$1.25 / $10", maxOutput: "128,000", latency: "-", speed: "-" },
  { name: "GPT-5", context: "400,000", cutoff: "April 2025", cost: "$1.25 / $10", maxOutput: "128,000", latency: "-", speed: "-" },
  { name: "Claude Opus 4.1", context: "200,000", cutoff: "April 2025", cost: "$15 / $75", maxOutput: "32,000", latency: "-", speed: "-" },
  { name: "Gemini 2.5 Pro", context: "1,000,000", cutoff: "Nov 2024", cost: "$1.25 / $10", maxOutput: "65,000", latency: "30s", speed: "191 t/s" },
  { name: "Claude 3.7 Sonnet", context: "200,000", cutoff: "Nov 2024", cost: "$3 / $15", maxOutput: "128,000", latency: "0.91s", speed: "78 t/s" },
  { name: "DeepSeek-R1", context: "128,000", cutoff: "Dec 2024", cost: "$0.55 / $2.19", maxOutput: "8,000", latency: "4s", speed: "24 t/s" },
  { name: "GPT-4o", context: "128,000", cutoff: "Oct 2023", cost: "$2.5 / $10", maxOutput: "4,096", latency: "0.51s", speed: "143 t/s" },
  { name: "Claude 3.5 Sonnet", context: "200,000", cutoff: "Apr 2024", cost: "$3 / $15", maxOutput: "4,096", latency: "1.22s", speed: "78 t/s" },
];

export function LLMLeaderboardBody() {
  return (
    <>
      <FullNavBar />
      <main className="main-wrapper">
        <div className="section_docs">
          <div className="padding-global">
            <div className="container-new docs">
              <div className="padding-section-medium">
                <div className="leaderboard-header">
                  <div className="leaderboard-updated">updated 15 Dec 2025</div>
                  <h1 className="heading-1-new text-color-white font-playfair">
                    LLM Leaderboard
                  </h1>
                  <p className="u-text-regular text-color-light-gray">
                    This LLM leaderboard displays the latest public benchmark performance for SOTA model versions released after April 2024. The data comes from model providers as well as independently run evaluations by Vellum or the open-source community. We feature results from non-saturated benchmarks, excluding outdated benchmarks (e.g. MMLU). If you want to use these models in your agents, <a href="https://app.vellum.ai/signup" target="_blank" rel="noreferrer">try Vellum.</a>
                  </p>
                  <div className="leaderboard-links">
                    <a href="https://www.vellum.ai/open-llm-leaderboard" target="_blank" rel="noreferrer" className="leaderboard-link">OS Leaderboard</a>
                    <a href="https://www.vellum.ai/best-llm-for-coding" target="_blank" rel="noreferrer" className="leaderboard-link">Coding Leaderboard</a>
                    <a href="https://www.vellum.ai/llm-cost-comparison" target="_blank" rel="noreferrer" className="leaderboard-link">Compare models</a>
                  </div>
                </div>

                <h2 className="heading-2-new text-color-white">Top models per tasks</h2>
                <div className="benchmark-grid">
                  {BENCHMARK_CATEGORIES.map((category) => (
                    <div key={category.title} className="benchmark-card">
                      <h3 className="benchmark-card-title">{category.title}</h3>
                      <div className="benchmark-models">
                        {category.models.map((model, index) => (
                          <div key={model.name} className="benchmark-model-row">
                            <span className="benchmark-rank">{index + 1}</span>
                            <span className="benchmark-model-name">{model.name}</span>
                            <span className="benchmark-score">{model.score}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>

                <h2 className="heading-2-new text-color-white">Fastest and most affordable models</h2>
                <div className="benchmark-grid">
                  {SPEED_CATEGORIES.map((category) => (
                    <div key={category.title} className="benchmark-card">
                      <h3 className="benchmark-card-title">{category.title}</h3>
                      <div className="benchmark-models">
                        {category.models.map((model, index) => (
                          <div key={model.name} className="benchmark-model-row">
                            <span className="benchmark-rank">{index + 1}</span>
                            <span className="benchmark-model-name">{model.name}</span>
                            <span className="benchmark-score">{model.score}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>

                <h2 className="heading-2-new text-color-white">Model Comparison</h2>
                <div className="model-table-wrapper">
                  <table className="model-table">
                    <thead>
                      <tr>
                        <th>Model</th>
                        <th>Context size</th>
                        <th>Cutoff date</th>
                        <th>I/O cost</th>
                        <th>Max output</th>
                        <th>Latency</th>
                        <th>Speed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {MODEL_TABLE.map((model) => (
                        <tr key={model.name}>
                          <td className="model-name-cell">{model.name}</td>
                          <td>{model.context}</td>
                          <td>{model.cutoff}</td>
                          <td>{model.cost}</td>
                          <td>{model.maxOutput}</td>
                          <td>{model.latency}</td>
                          <td>{model.speed}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
      <WorkflowCTA />
    </>
  );
}
