import subprocess
import time
import sys

def main():

    if sys.argv[1] == "update":
        subprocess.run(["python", "data_pipeline/main.py"])
        print("Updated FPL Tables from FPL API")
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