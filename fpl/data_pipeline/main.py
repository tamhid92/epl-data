import init_fpl_elements
import fpl_bootstrap
import os

DB_HOST = os.environ.get("DB_HOST")
DB_PORT = os.environ.get("DB_PORT")
DB_NAME = os.environ.get("DB_NAME")
DB_USER = os.environ.get("DB_USER")
DB_PASS = os.environ.get("DB_PASS")

def conn_str() -> str:
    return f"postgresql+psycopg2://{DB_USER}:{DB_PASS}@{DB_HOST}:{DB_PORT}/{DB_NAME}"

def main():
    print("Inserting elements from FPL and enriching it with Understat and FBRef Data")
    gameweek = init_fpl_elements.insert_fpl_elements(conn_str())
    
    print("Importing FPL Bootstrap into Postgres")
    fpl_bootstrap.fpl_bootstrap(conn_str())

if __name__ == "__main__":
    main()