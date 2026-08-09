def fibonacci(n):
 """Return the first n numbers in the Fibonacci series."""
 if n <= 0:
 return []
 elif n == 1:
 return [0]
 elif n == 2:
 return [0, 1]
 
 series = [0, 1]
 for i in range(2, n):
 series.append(series[-1] + series[-2])
 return series


def fibonacci_recursive(n):
 """Return the nth Fibonacci number (0-indexed) recursively."""
 if n <= 0:
 return 0
 elif n == 1:
 return 1
 else:
 return fibonacci_recursive(n - 1) + fibonacci_recursive(n - 2)


def fibonacci_generator():
 """Generate Fibonacci numbers infinitely."""
 a, b = 0, 1
 while True:
 yield a
 a, b = b, a + b


if name == 'main':
 # Example usage
 n = 10
 print(f'First {n} Fibonacci numbers: {fibonacci(n)}')
 
 print(f'Fibonacci number at position 10: {fibonacci_recursive(10)}')
 
 print('First 10 numbers using generator:')
 gen = fibonacci_generator()
 for _ in range(10):
 print(next(gen), end=' ')
 print()
