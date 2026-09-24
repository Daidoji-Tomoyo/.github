#!/usr/bin/env python3

import argparse
import json
import math
import os
import urllib.parse
import urllib.request

from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path


API = "https://api.github.com"
WEEKS = 53


def request_json(path):
    token = os.getenv("GITHUB_TOKEN")

    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "org-activity-graph",
    }

    if token:
        headers["Authorization"] = f"Bearer {token}"

    req = urllib.request.Request(
        API + path,
        headers=headers,
    )

    with urllib.request.urlopen(req) as response:
        return json.loads(response.read())


def get_repositories(org):
    repos = []
    page = 1

    while True:
        query = urllib.parse.urlencode({
            "type": "all",
            "per_page": 100,
            "page": page,
        })

        data = request_json(
            f"/orgs/{org}/repos?{query}"
        )

        repos.extend(data)

        if len(data) < 100:
            break

        page += 1

    return [
        repo
        for repo in repos
        if repo.get("default_branch")
        and not repo.get("fork")
        and not repo.get("disabled")
        # 不统计这个自动生成 SVG 的仓库本身
        and repo.get("name") != ".github"
    ]


def get_commits(org, repo, start, end):
    result = Counter()

    since = (
        datetime.combine(
            start,
            datetime.min.time(),
            tzinfo=timezone.utc,
        )
        .isoformat()
        .replace("+00:00", "Z")
    )

    until = (
        datetime.combine(
            end + timedelta(days=1),
            datetime.min.time(),
            tzinfo=timezone.utc,
        )
        - timedelta(seconds=1)
    ).isoformat().replace("+00:00", "Z")

    page = 1

    while True:
        query = urllib.parse.urlencode({
            "sha": repo["default_branch"],
            "since": since,
            "until": until,
            "per_page": 100,
            "page": page,
        })

        commits = request_json(
            f"/repos/{org}/{repo['name']}/commits?{query}"
        )

        for item in commits:
            commit = item.get("commit", {})
            author = commit.get("author") or {}
            committer = commit.get("committer") or {}

            timestamp = (
                author.get("date")
                or committer.get("date")
            )

            if timestamp:
                result[timestamp[:10]] += 1

        if len(commits) < 100:
            break

        page += 1

    return result


def calendar_range():
    today = datetime.now(timezone.utc).date()

    # Sunday = 第一列
    sunday_offset = (today.weekday() + 1) % 7
    current_sunday = today - timedelta(days=sunday_offset)

    start = current_sunday - timedelta(
        weeks=WEEKS - 1
    )

    return start, today


def thresholds(values):
    values = sorted(v for v in values if v > 0)

    if not values:
        return [1, 2, 3, 4]

    result = []

    for q in [0.25, 0.50, 0.75, 1.0]:
        index = min(
            len(values) - 1,
            math.ceil(len(values) * q) - 1,
        )

        result.append(values[index])

    return result


def level(count, ranges):
    if count == 0:
        return 0

    if count <= ranges[0]:
        return 1
    if count <= ranges[1]:
        return 2
    if count <= ranges[2]:
        return 3

    return 4


THEMES = {
    "light": {
        "background": "#ffffff",
        "text": "#24292f",
        "muted": "#57606a",
        "empty": "#ebedf0",
        "border": "#d0d7de",
        "levels": [
            "#9be9a8",
            "#40c463",
            "#30a14e",
            "#216e39",
        ],
    },

    "dark": {
        "background": "#0d1117",
        "text": "#c9d1d9",
        "muted": "#8b949e",
        "empty": "#161b22",
        "border": "#30363d",
        "levels": [
            "#0e4429",
            "#006d32",
            "#26a641",
            "#39d353",
        ],
    },
}


def darker(hex_color, multiplier):
    value = hex_color.lstrip("#")

    rgb = [
        int(value[i:i + 2], 16)
        for i in (0, 2, 4)
    ]

    rgb = [
        max(0, min(255, int(x * multiplier)))
        for x in rgb
    ]

    return "#" + "".join(
        f"{x:02x}" for x in rgb
    )


def generate_svg(
    org,
    counts,
    start,
    repositories,
    theme_name,
):
    theme = THEMES[theme_name]

    cell = 10
    gap = 4
    pitch = cell + gap

    left = 70
    top = 90

    width = 860
    height = 255

    values = []

    for i in range(WEEKS * 7):
        day = start + timedelta(days=i)
        values.append(counts.get(day.isoformat(), 0))

    ranges = thresholds(values)
    total = sum(values)

    svg = [
        f'''
<svg
  xmlns="http://www.w3.org/2000/svg"
  width="{width}"
  height="{height}"
  viewBox="0 0 {width} {height}"
>
''',

        f'''
<rect
  x="0.5"
  y="0.5"
  width="{width - 1}"
  height="{height - 1}"
  rx="12"
  fill="{theme["background"]}"
  stroke="{theme["border"]}"
/>
''',

        f'''
<text
  x="28"
  y="34"
  fill="{theme["text"]}"
  font-size="18"
  font-weight="600"
  font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif"
>
{org} · Organization Activity
</text>
''',

        f'''
<text
  x="28"
  y="57"
  fill="{theme["muted"]}"
  font-size="12"
  font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif"
>
{total:,} commits · {repositories} repositories · last 53 weeks
</text>
'''
    ]

    # 星期
    for label, row in [
        ("Mon", 1),
        ("Wed", 3),
        ("Fri", 5),
    ]:
        y = top + row * pitch + 9

        svg.append(
            f'''
<text
  x="28"
  y="{y}"
  fill="{theme["muted"]}"
  font-size="10"
  font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif"
>
{label}
</text>
'''
        )

    # 月份
    last_month = None

    for week in range(WEEKS):
        day = start + timedelta(weeks=week)

        if day.month != last_month:
            x = left + week * pitch

            svg.append(
                f'''
<text
  x="{x}"
  y="{top - 16}"
  fill="{theme["muted"]}"
  font-size="10"
  font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif"
>
{day.strftime("%b")}
</text>
'''
            )

            last_month = day.month

    today = date.today()

    # contribution blocks
    for week in range(WEEKS):
        for row in range(7):

            day = start + timedelta(
                weeks=week,
                days=row,
            )

            count = (
                counts.get(day.isoformat(), 0)
                if day <= today
                else 0
            )

            lv = level(count, ranges)

            x = left + week * pitch
            y = top + row * pitch

            if lv == 0:
                svg.append(
                    f'''
<rect
  x="{x}"
  y="{y}"
  width="{cell}"
  height="{cell}"
  rx="2"
  fill="{theme["empty"]}"
>
<title>{day}: {count} commits</title>
</rect>
'''
                )

                continue

            color = theme["levels"][lv - 1]

            # 立体柱高度
            height_3d = 3 + lv * 4
            top_y = y - height_3d

            side = darker(color, 0.72)

            svg.append(
                f'''
<g>
<title>{day}: {count} commits</title>

<rect
  x="{x}"
  y="{top_y}"
  width="{cell}"
  height="{height_3d + cell}"
  rx="1"
  fill="{color}"
/>

<polygon
  points="
    {x + cell},{top_y}
    {x + cell + 3},{top_y - 3}
    {x + cell + 3},{y + cell - 3}
    {x + cell},{y + cell}
  "
  fill="{side}"
/>

</g>
'''
            )

    svg.append("</svg>")

    return "".join(svg)


def main():
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "--org",
        required=True,
    )

    parser.add_argument(
        "--output",
        default="profile-org-contrib",
    )

    args = parser.parse_args()

    start, end = calendar_range()

    repos = get_repositories(args.org)

    counts = Counter()

    print(
        f"Scanning {len(repos)} repositories..."
    )

    successful = 0

    for repo in repos:
        try:
            repo_counts = get_commits(
                args.org,
                repo,
                start,
                end,
            )

            counts.update(repo_counts)

            successful += 1

            print(
                f"{repo['name']}: "
                f"{sum(repo_counts.values())} commits"
            )

        except Exception as error:
            print(
                f"Skipping {repo['name']}: {error}"
            )

    output = Path(args.output)

    output.mkdir(
        parents=True,
        exist_ok=True,
    )

    light = generate_svg(
        args.org,
        counts,
        start,
        successful,
        "light",
    )

    dark = generate_svg(
        args.org,
        counts,
        start,
        successful,
        "dark",
    )

    (output / "org-light.svg").write_text(
        light,
        encoding="utf-8",
    )

    (output / "org-night.svg").write_text(
        dark,
        encoding="utf-8",
    )

    print(
        f"Generated activity graph: "
        f"{sum(counts.values())} commits"
    )


if __name__ == "__main__":
    main()
