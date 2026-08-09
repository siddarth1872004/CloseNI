class QuickSort:
    def init(self, data):
        self.data = data

    def sort(self):
        self._quick_sort(0, len(self.data) - 1)
        return self.data

    def _quick_sort(self, low, high):
        if low < high:
            pi = self._partition(low, high)
            self._quick_sort(low, pi - 1)
            self._quick_sort(pi + 1, high)

    def _partition(self, low, high):
        pivot = self.data[high]
        i = low - 1
        for j in range(low, high):
            if self.data[j] <= pivot:
                i += 1
                self.data[i], self.data[j] = self.data[j], self.data[i]
        self.data[i + 1], self.data[high] = self.data[high], self.data[i + 1]
        return i + 1

if name == 'main':
    arr = [10, 7, 8, 9, 1, 5]
    sorter = QuickSort(arr)
    print('Sorted array:', sorter.sort())
