import time
import pandas as pd
import undetected_chromedriver as uc
from bs4 import BeautifulSoup
import os

def scrape_all_topics():
    # อ่านไฟล์ topics ที่ดึงมาแล้ว
    topics_file = 'topics_list.xlsx'
    if not os.path.exists(topics_file):
        print(f"ไม่พบไฟล์ {topics_file}")
        return

    df_topics = pd.read_excel(topics_file)
    
    # ตั้งค่า Chrome Options
    options = uc.ChromeOptions()
    # options.add_argument('--headless') # ปิด headless เพื่อให้หลบ Cloudflare ได้ดีขึ้น
    options.add_argument('--disable-gpu')
    
    driver = uc.Chrome(options=options, version_main=149)
    
    all_articles = []
    
    try:
        total_topics = len(df_topics)
        for index, row in df_topics.iterrows():
            topic_name = row['Name']
            topic_url = row['URL']
            
            print(f"[{index+1}/{total_topics}] กำลังดึงข้อมูลจาก Topic: {topic_name}...")
            
            # โหลดหน้าแรกของ Topic
            current_url = topic_url
            page = 1
            
            while current_url:
                driver.get(current_url)
                time.sleep(5) # รอ Cloudflare และโหลดหน้า
                
                soup = BeautifulSoup(driver.page_source, 'lxml')
                
                # หาลิงก์บทความทั้งหมดในหน้านี้
                links = soup.find_all('a')
                found_in_page = 0
                for a in links:
                    href = a.get('href', '')
                    if any(x in href for x in ['/article/', '/guide/', '/blog/', '/video/']):
                        # หา Title ที่แท้จริงจาก tag h3 หรือ h2 ในการ์ดบทความ
                        title_tag = a.find(['h3', 'h2'])
                        if title_tag:
                            title = title_tag.get_text(strip=True)
                        else:
                            title = a.get_text(strip=True)
                            
                        # บางอันอาจจะเป็นปุ่มหรือไม่มี text ข้ามไป
                        if not title or len(title) < 5 or title.lower() == 'coupon codes':
                            continue
                            
                        # ทำความสะอาด Title
                        title = title.strip()
                            
                        full_link = f"https://www.webstaurantstore.com{href}" if href.startswith('/') else href
                        
                        # เช็คว่าซ้ำในหมวดหมู่เดียวกันไหม (ยอมให้ซ้ำข้ามหมวดหมู่ได้เพื่อให้ยอดรวมตรง)
                        if not any(d['URL'] == full_link and d['Topic'] == topic_name for d in all_articles):
                            all_articles.append({
                                'Topic': topic_name,
                                'Title': title,
                                'URL': full_link
                            })
                            found_in_page += 1
                
                print(f"  - หน้า {page} พบ {found_in_page} บทความ")
                
                # ถ้าหน้านี้ไม่พบบทความเลย = ถึงจุดสิ้นสุดแล้ว หยุดได้เลย
                if found_in_page == 0:
                    current_url = None
                    continue
                
                # ตรวจสอบปุ่ม Next Page (ใช้ aria-label="Next page")
                next_btn = soup.find('a', attrs={'aria-label': 'Next page'})
                if next_btn and next_btn.get('href'):
                    current_url = f"https://www.webstaurantstore.com{next_btn['href']}"
                    page += 1
                else:
                    current_url = None # จบ loop หน้า
                    
    except Exception as e:
        print(f"เกิดข้อผิดพลาด: {e}")
    finally:
        driver.quit()
        
    # บันทึกผลลัพธ์ทั้งหมด
    if all_articles:
        df_result = pd.DataFrame(all_articles)
        output_file = 'all_articles_list.xlsx'
        df_result.to_excel(output_file, index=False)
        print(f"\nดึงข้อมูลเสร็จสิ้น! พบทั้งหมด {len(all_articles)} บทความ")
        print(f"บันทึกไฟล์ลงที่: {output_file}")
    else:
        print("\nไม่พบบทความเลย")

if __name__ == "__main__":
    scrape_all_topics()
