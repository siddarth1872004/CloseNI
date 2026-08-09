from counter import Counter

if __name__ == '__main__':
    c = Counter()
    for _ in range(5):
        c.increment()
    print(c.count)
    print('Finished incrementing')
