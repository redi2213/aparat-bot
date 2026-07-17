import requests
from concurrent.futures import ThreadPoolExecutor, as_completed

API_BASE_URL = "https://www.aparat.com/api/fa/v1"
OUTFILE = "/storage/self/primary/0cdn/linkx/Aparat.txt"

headers = {
    "User-Agent": "Mozilla/5.0",
    "Referer": "https://www.aparat.com/"
}

url = input("Link: ").strip().rstrip("/")

if "/playlist/" in url:
    mode = "playlist"
    pid = url.split("/")[-1]
elif "/v/" in url:
    mode = "video"
    vid = url.split("/")[-1]
else:
    print("Invalid link")
    exit()

def get_video(uid, playlist=None):
    q = f"?playlist={playlist}&pr=1&mf=1" if playlist else ""
    j = requests.get(
        f"{API_BASE_URL}/video/video/show/videohash/{uid}{q}",
        headers=headers
    ).json()

    a = j["data"]["attributes"]

    return [
        {
            "title": a["title"],
            "profile": x["profile"],
            "url": x["urls"][0]
        }
        for x in a["file_link_all"]
    ]

videos = []

if mode == "video":
    videos.append(get_video(vid))
else:
    j = requests.get(
        f"{API_BASE_URL}/video/playlist/one/playlist_id/{pid}",
        headers=headers
    ).json()

    ids = [
        x["attributes"]["uid"]
        for x in j["included"]
        if x["type"] == "Video"
    ]

    with ThreadPoolExecutor(max_workers=10) as ex:
        fs = [ex.submit(get_video, i, pid) for i in ids]
        for f in as_completed(fs):
            videos.append(f.result())

qualities = sorted(
    {
        q["profile"]
        for v in videos
        for q in v
    },
    key=lambda x: int(x[:-1])
)

print()

for i, q in enumerate(qualities, 1):
    print(f"{i}) {q}")
choice = int(input("\nQuality number: "))

if choice < 1 or choice > len(qualities):
    print("Wrong choice")
    exit()

selected = qualities[choice - 1]

print("Selected:", selected)

with open(OUTFILE, "w", encoding="utf-8") as f:
    for video in videos:
        match = None

        for q in video:
            if q["profile"] == selected:
                match = q
                break

        if match:
            f.write(match["url"] + "\n")

print("\nDone")
print(OUTFILE)
~ $
