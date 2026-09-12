read -p "Are you sure you want to continue? (y/n) " -n 1 -r
echo # Move to a new line

if [[ ! $REPLY =~ ^[Yy]$ ]]
then
    echo "Aborted."
    exit 1
fi


rm production.db
rm production.db-shm
rm production.db-wal