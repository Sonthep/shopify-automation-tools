import sys
import csv
import yt_dlp

sys.stdout.reconfigure(encoding='utf-8')

def get_youtube_videos(query, max_results=5):
    """
    ดึงข้อมูล Title และ Link จาก YouTube
    query: สามารถเป็นคำค้นหา (เช่น "เพลงฮิต") หรือ URL ของช่อง/เพลย์ลิสต์
    """
    ydl_opts = {
        'extract_flat': 'in_playlist', # ดึงแค่ข้อมูล ไม่ดาวน์โหลดวิดีโอ
        'quiet': True,
    }

    results = []
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        try:
            # ถ้าไม่ใช่ URL ให้เติม ytsearch เข้าไปเพื่อให้ค้นหาแทน
            search_query = f"ytsearch{max_results}:{query}" if not query.startswith("http") else query
            
            print(f"กำลังดึงข้อมูล: {query}...")
            info = ydl.extract_info(search_query, download=False)
            
            if 'entries' in info:
                # กรณีเป็นผลการค้นหา หรือ เพลย์ลิสต์/ช่อง
                if query.startswith("http") and max_results is not None:
                    entries = list(info['entries'])[:max_results]
                else:
                    entries = list(info['entries'])
                
                for entry in entries:
                    if entry:
                        title = entry.get('title')
                        url = entry.get('url')
                        # จัดการกรณี URL มาแค่ ID ของวิดีโอ
                        if url and not url.startswith('http'):
                            url = f"https://www.youtube.com/watch?v={url}"
                        results.append({'title': title, 'link': url})
            else:
                # กรณีเป็นวิดีโอเดียว
                title = info.get('title')
                url = info.get('webpage_url', info.get('url'))
                results.append({'title': title, 'link': url})
                
        except Exception as e:
            print(f"เกิดข้อผิดพลาด: {e}")

    return results

if __name__ == "__main__":
    # --- คุณสามารถเปลี่ยนคำค้นหา หรือใส่ URL ของ Playlist ตรงนี้ได้เลย ---
    target = "https://www.youtube.com/@Sevenfivedistributor/videos" 
    # target = "https://www.youtube.com/playlist?list=PL..." # ตัวอย่างการใส่ URL
    
    # ดึงทุกรายการโดยไม่จำกัดจำนวน (ตั้ง max_results=None)
    videos = get_youtube_videos(target, max_results=None)
    
    print("\n--- ผลลัพธ์ ---")
    for idx, video in enumerate(videos, 1):
        print(f"[{idx}] {video['title']}")
        print(f"    Link: {video['link']}\n")
        
    # บันทึกลงไฟล์ CSV (เปิดด้วย Excel ได้)
    csv_filename = "youtube_results.csv"
    with open(csv_filename, mode='w', newline='', encoding='utf-8-sig') as f:
        writer = csv.writer(f)
        writer.writerow(['Title', 'Link'])
        for video in videos:
            writer.writerow([video['title'], video['link']])
            
    print(f"บันทึกข้อมูลลงไฟล์ {csv_filename} เรียบร้อยแล้ว! 🎉")
