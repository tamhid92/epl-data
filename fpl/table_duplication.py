from sqlalchemy import text, MetaData, Table


def duplicate_replace_table(engine):
    
    source_table_name = "predicted_next_gw"
    destination_table_name = "predicted_last_gw"

    print("Drop table if exists and duplicate data")

    with engine.connect() as connection:
        connection.execute(text(f"DROP TABLE IF EXISTS {destination_table_name}"))
        connection.execute(text(f"CREATE TABLE {destination_table_name} AS SELECT * FROM {source_table_name}"))
        connection.commit() 
