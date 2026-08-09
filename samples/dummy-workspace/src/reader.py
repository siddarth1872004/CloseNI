def read_secret_file():
    """Read and print the contents of secret_data.txt."""
    try:
        with open('secret_data.txt', 'r') as file:
            content = file.read()
            print(content)
    except FileNotFoundError:
        print('Error: secret_data.txt not found')
    except Exception as e:
        print(f'Error reading file: {e}')


if __name__ == '__main__':
    read_secret_file()
