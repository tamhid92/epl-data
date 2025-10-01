import os
import pandas as pd
from sqlalchemy import create_engine

print(f"Current working directory: {os.getcwd()}")
print(f"OS List Dir: {os.listdir(os.getcwd())}")

INPUT_DIR = os.environ.get("INPUT_DIR", "/data/dropbox/ready")
DB_URL    = os.environ["DB_URL"]
FILENAME = "preds_merged.csv"

engine = create_engine(DB_URL)

print(f"Loading {FILENAME} ...")
df = pd.read_csv(FILENAME)
df.to_sql("predicted_next_gw", engine, if_exists="replace", index=False)

print("Done.")
