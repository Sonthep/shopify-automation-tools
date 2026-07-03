import time
from bs4 import BeautifulSoup
import undetected_chromedriver as uc

def scrape_webstaurant_blog(url):
    print(f"กำลัง Scrape ข้อมูลจาก: {url}")
    
    # ตั้งค่า Chrome Options
    options = uc.ChromeOptions()
    options.add_argument('--headless') # ถ้าอยากดูจอให้ comment บรรทัดนี้
    options.add_argument('--disable-gpu')
    
    # เปิด Chrome ด้วย undetected_chromedriver เพื่อหลบ Cloudflare
    driver = uc.Chrome(options=options)
    
    try:
        driver.get(url)
        # รอให้หน้าเว็บโหลดเสร็จ (Cloudflare อาจจะใช้เวลาประมาณ 5 วินาที)
        time.sleep(8)
        
        # ดึง HTML มา
        html = driver.page_source
        soup = BeautifulSoup(html, 'lxml')
        
        # ค้นหา Title
        title_element = soup.find('h1')
        title = title_element.text.strip() if title_element else "ไม่พบ Title"
        
        # ค้นหาเนื้อหาบทความทั้งหมด 
        # (ส่วนใหญ่จะอยู่ใน article, div ที่มีคลาสเจาะจง หรืออ่านจาก p ทั้งหมดใน container)
        # วิธีที่ปลอดภัยที่สุดในการดึง text ทั้งหมดของบทความคือดึงจาก tag <p>, <h2>, <h3>
        article_data = []
        
        # บางทีเนื้อหาจะอยู่ใน div class="container" หรือ "article-body"
        # แต่เพื่อความครอบคลุม เราจะหาเนื้อหาหลัก (main content)
        content_container = soup.find('div', class_='col-span-full xl:col-span-8') or soup.find('article') or soup
        
        for element in content_container.find_all(['h2', 'h3', 'p', 'ul', 'li']):
            text = element.get_text(strip=True)
            if text:
                article_data.append(text)
                
        full_content = "\n\n".join(article_data)
        
        result = {
            'title': title,
            'content': full_content
        }
        
        print("\n=== ดึงข้อมูลสำเร็จ ===")
        print(f"Title: {title}")
        print(f"Content Length: {len(full_content)} ตัวอักษร")
        
        return result
        
    except Exception as e:
        print(f"เกิดข้อผิดพลาด: {e}")
    finally:
        driver.quit()

if __name__ == "__main__":
    import pandas as pd
    
    target_url = "https://www.webstaurantstore.com/article/1122/what-is-japanese-cuisine.html"
    data = scrape_webstaurant_blog(target_url)
    
    if data:
        # บันทึกลงเป็นไฟล์ Excel
        df = pd.DataFrame([{
            'Title': data['title'],
            'URL': target_url
        }])
        
        excel_filename = 'blog_list.xlsx'
        df.to_excel(excel_filename, index=False)
        print(f"\nบันทึกข้อมูลลงไฟล์ {excel_filename} เรียบร้อยแล้ว")
