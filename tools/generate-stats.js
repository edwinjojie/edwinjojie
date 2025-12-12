// tools/generate-stats.js
// Generates top-langs.svg, streak.svg, and activity-spark.svg into ../assets/stats/
// Requires env: GITHUB_TOKEN, GH_USERNAME

import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { Octokit } from "octokit";

const OUTDIR = path.resolve(process.cwd(), "../assets/stats");
if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });

const TOKEN = process.env.GITHUB_TOKEN;
const USER = process.env.GH_USERNAME;
if (!TOKEN || !USER) {
  console.error("Missing GITHUB_TOKEN or GH_USERNAME env var");
  process.exit(1);
}

const octokit = new Octokit({ auth: TOKEN });

async function fetchAllRepos(username) {
  const repos = [];
  let page = 1;
  while (true) {
    const res = await octokit.rest.repos.listForUser({
      username,
      per_page: 100,
      page,
      type: "owner",
    });
    repos.push(...res.data);
    if (res.data.length < 100) break;
    page++;
  }
  return repos;
}

async function computeTopLanguages(repos) {
  const langTotals = {};
  for (const r of repos) {
    // skip forks for language calc
    if (r.fork) continue;
    try {
      const res = await octokit.request("GET /repos/{owner}/{repo}/languages", {
        owner: USER,
        repo: r.name,
      });
      const langs = res.data;
      for (const [lang, bytes] of Object.entries(langs)) {
        langTotals[lang] = (langTotals[lang] || 0) + bytes;
      }
    } catch (err) {
      console.warn("language fetch failed for", r.name, err.message);
    }
  }
  // Sort and pick top 6
  const top = Object.entries(langTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([lang, bytes]) => ({ lang, bytes }));
  const total = Object.values(langTotals).reduce((a, b) => a + b, 0) || 1;
  return { top, total };
}

function mkLangsSVG(top, total) {
  // Simple horizontal bar chart SVG
  const width = 760;
  const rowH = 28;
  const height = top.length * rowH + 40;
  const colors = [
    "#ff7b00", "#1f77b4", "#2ca02c", "#d62728", "#9467bd", "#8c564b",
  ];

  let rows = "";
  top.forEach((t, i) => {
    const pct = Math.round((t.bytes / total) * 1000) / 10;
    const barW = Math.max(6, Math.round((t.bytes / total) * (width - 220)));
    const y = 30 + i * rowH;
    rows += `
      <text x="12" y="${y+14}" font-size="12" fill="#cbd5e1">${t.lang}</text>
      <rect x="140" y="${y+2}" width="${barW}" height="18" rx="6" fill="${colors[i%colors.length]}" />
      <text x="${140 + Math.max(barW, 6) + 8}" y="${y+14}" font-size="12" fill="#cbd5e1">${pct}%</text>
    `;
  });

  return `<?xml version="1.0" encoding="utf-8"?>
  <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#0b1220" rx="8"/>
    <text x="20" y="20" font-size="14" fill="#e6f0ff">Top Languages</text>
    ${rows}
  </svg>`;
}

async function fetchContributionCalendar(username) {
  // Use GraphQL to get contribution calendar
  const query = `
    query userCalendar($login: String!) {
      user(login: $login) {
        contributionsCollection {
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                date
                contributionCount
              }
            }
          }
        }
      }
    }
  `;
  const res = await octokit.graphql(query, { login: username });
  const weeks = res.user.contributionsCollection.contributionCalendar.weeks;
  const days = [];
  weeks.forEach(w => {
    w.contributionDays.forEach(d => days.push({ date: d.date, count: d.contributionCount }));
  });
  // sort to ascending by date
  days.sort((a,b)=> new Date(a.date)-new Date(b.date));
  return days;
}

function computeStreak(days) {
  // days is array of {date, count} ascending. Compute current consecutive days with count>0 from last day.
  const today = new Date(days[days.length - 1].date);
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    const d = new Date(days[i].date);
    const diff = Math.round((today - d) / (1000*60*60*24));
    if (diff === 0 || diff === (days.length - 1 - i)) {
      // check matching date spacing (allowing continuous)
    }
    if (days[i].count > 0) {
      // If this day is contiguous with streak (we check day-by-day)
      if (streak === 0) {
        // first non-zero day -> set lastSeen = date
        streak = 1;
        var lastDate = new Date(days[i].date);
      } else {
        // require that lastDate - thisDate == 1 day
        const curr = new Date(days[i].date);
        const diffDays = Math.round((lastDate - curr) / (1000*60*60*24));
        if (diffDays === 1) {
          streak++;
          lastDate = curr;
        } else {
          break;
        }
      }
    } else {
      // if zero encountered and streak>0 break, else continue searching backward
      if (streak > 0) break;
    }
  }
  return streak;
}

function mkStreakSVG(streak) {
  const width = 640, height = 120;
  return `<?xml version="1.0" encoding="utf-8"?>
  <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#071024" rx="10"/>
    <text x="30" y="40" font-size="20" fill="#e6f0ff">Current GitHub Streak</text>
    <text x="30" y="84" font-size="48" font-weight="700" fill="#ff9f1c">${streak} day${streak!==1?'s':''}</text>
  </svg>`;
}

function mkActivitySparkSVG(last30) {
  // last30: array of counts (ascending)
  const width = 760, height = 80, pad = 20;
  const max = Math.max(...last30, 1);
  const step = (width - pad*2) / (last30.length - 1);
  const points = last30.map((v,i) => {
    const x = pad + i*step;
    const y = height - pad - (v/max)*(height - pad*2);
    return `${x},${y}`;
  }).join(" ");
  // bars for days
  const bars = last30.map((v,i) => {
    const x = pad + i*step - 4;
    const barH = (v/max)*(height - pad*2);
    const y = height - pad - barH;
    return `<rect x="${x}" y="${y}" width="8" height="${barH}" rx="2" fill="#2dd4bf" />`;
  }).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
  <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#071024" rx="8"/>
    <text x="16" y="20" font-size="12" fill="#cbd5e1">Last 30 days activity</text>
    ${bars}
  </svg>`;
}

(async ()=> {
  try {
    const repos = await fetchAllRepos(USER);
    const { top, total } = await computeTopLanguages(repos);
    const topSVG = mkLangsSVG(top, total);
    fs.writeFileSync(path.join(OUTDIR, "top-langs.svg"), topSVG, "utf8");
    console.log("top-langs.svg written");

    const days = await fetchContributionCalendar(USER);
    // last 30 days
    const tail = days.slice(-30).map(d => d.count);
    const streak = computeStreak(days);
    fs.writeFileSync(path.join(OUTDIR, "streak.svg"), mkStreakSVG(streak), "utf8");
    fs.writeFileSync(path.join(OUTDIR, "activity-spark.svg"), mkActivitySparkSVG(tail), "utf8");
    console.log("streak.svg & activity-spark.svg written");
  } catch (err) {
    console.error("Error generating stats:", err);
    process.exit(1);
  }
})();
