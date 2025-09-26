import subprocess
import time
import sys

def main():

    if sys.argv[1] == "update":
        subprocess.run(["python", "data_pipeline/main.py"])
        subprocess.run(["python", "training/lgb_model.py", "--workdir", "data", "--output", "predictions.csv", "--config", "training/config.toml"])
        print("Completed training and validation. Created predictions.csv")
        time.sleep(5)
        print("Running script to enrich and insert predictions to postgres")
        subprocess.run(["python", "training/preds_to_postgres.py", "--predictions", "predictions.csv", "--out", "postgres_predictions.csv"])
    else:
        print("Invalid Argument. Run with arg 'update'")
        exit(1)

if __name__ == "__main__":
    if len(sys.argv) > 1:
        print(f"Running {sys.argv[0]}")
        print(f"Arguments received: {sys.argv[1]}")
        main()
    else:
        print("No arguments provided.")
