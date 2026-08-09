class Counter:
    def __init__(self):
        self.count = 0

    def increment(self):
        self.count += 1

if __name__ == '__main__':
    c = Counter()
    for _ in range(3):
        c.increment()
    print(c.count)
    print('Finished incrementing')
