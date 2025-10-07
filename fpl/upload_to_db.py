import os
import pandas as pd
from sqlalchemy import create_engine
import table_duplication
import fpl_metrics

print("-------- UPLOAD TO DB SCRIPT --------")

DB_HOST = os.environ.get('DB_HOST')
DB_PORT = os.environ.get('DB_PORT')
DB_NAME = os.environ.get('DB_NAME')
DB_USER = os.environ.get('DB_USER')
DB_PASS = os.environ.get("DB_PASS")
API_TOKEN = os.environ.get("API_TOKEN")
DB_URL = f"postgresql+psycopg2://{DB_USER}:{DB_PASS}@{DB_HOST}:{DB_PORT}/{DB_NAME}"

INPUT_DIR = os.environ.get("INPUT_DIR", "/ready")
FILENAME = "preds_merged.csv"

engine = create_engine(DB_URL)

table_duplication.duplicate_replace_table(engine)
fpl_metrics.main(engine, API_TOKEN)

print(f"OS List Dir: {os.listdir(INPUT_DIR)}")
print(f"Loading {FILENAME} ...")
df = pd.read_csv(f"{INPUT_DIR}/{FILENAME}")
df.to_sql("predicted_next_gw", engine, if_exists="replace", index=False)

print("Done.")
