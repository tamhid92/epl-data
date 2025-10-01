import os
import pandas as pd
from sqlalchemy import create_engine

print(f"Current working directory: {os.getcwd()}")

INPUT_DIR = os.environ.get("INPUT_DIR", "/ready")
DB_URL    = os.environ["DB_URL"]
print(DB_URL)
FILENAME = "preds_merged.csv"

engine = create_engine(DB_URL)

print(f"OS List Dir: {os.listdir(INPUT_DIR)}")
print(f"Loading {FILENAME} ...")
df = pd.read_csv(f"{INPUT_DIR}/{FILENAME}")
df.to_sql("predicted_next_gw", engine, if_exists="replace", index=False)

print("Done.")
