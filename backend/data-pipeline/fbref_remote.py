# fbref_remote.py
import os
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from ScraperFC.fbref import FBref as _FBref

class FBrefRemote(_FBref):
    def _driver_init(self) -> None:
        opts = Options()
        opts.add_argument("--headless=new")
        opts.add_argument("--disable-dev-shm-usage")
        opts.add_argument("--no-first-run")
        opts.add_argument("--no-default-browser-check")

        remote = os.getenv("SELENIUM_URL", "http://localhost:4444")
        self.driver = webdriver.Remote(command_executor=remote, options=opts)
        self.driver.set_page_load_timeout(60)

    def _driver_close(self) -> None:
        try:
            self.driver.quit()
        except Exception:
            pass
